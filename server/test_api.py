#!/usr/bin/env python3
"""End-to-end tests for the agent poker API.

Starts the Deno server on a scratch port, then drives full agent-vs-bots games over HTTP.

Covers:
1.  health + game creation
2.  full tournament to game over via a scripted agent
3.  information-hiding audit: no response ever leaks bot hole cards, the deck, or the graveyard
    (outside of sanctioned showdown reveals)
4.  no turn timer: the agent may sleep a long time before acting and the action is still accepted
5.  action validation: bad tokens, wrong-turn actions, impossible checks, clamped raises, call->check
6.  history endpoint and game abort

Usage: python test_api.py [--deno <deno path>]
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exampleAgent import AgentPokerClient, PokerApiError  # noqa: E402

PORT = 8891
BASE_URL = f"http://127.0.0.1:{PORT}"
CARD_CODES = set(f"{rank}{suit}" for rank in "23456789TJQKA" for suit in "CDHS")


class TestFailure(AssertionError):
    pass


def check(condition, message):
    if not condition:
        raise TestFailure(message)
    print(f"  ok: {message}")


def find_card_bearers(node, path="state", found=None):
    """Collect (path, seatIndex, cards) for every dict that carries holeCards, plus deck keys."""
    if found is None:
        found = []
    if isinstance(node, dict):
        if "holeCards" in node:
            found.append((path, node.get("seatIndex"), node.get("holeCards")))
        for key, value in node.items():
            if key in ("deck", "cardGraveyard"):
                found.append((f"{path}.{key}", None, value))
            elif key == "holeCards":
                continue
            else:
                find_card_bearers(value, f"{path}.{key}", found)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            find_card_bearers(value, f"{path}[{index}]", found)
    return found


def audit_no_card_leaks(payload, label, allow_reveals=False, agent_seat=0):
    """holeCards are allowed only for the agent seat, or everywhere when allow_reveals is set
    (hand_result showdown states). deck/cardGraveyard keys are never allowed.

    Note: the players array is NOT indexed by seat (the engine rotates seat order each hand);
    always read seatIndex from the player object itself.
    """
    for path, seat, cards in find_card_bearers(payload, label):
        if not cards:
            continue
        if seat is None:
            raise TestFailure(f"{label}: deck data leaked at {path}: {cards}")
        if allow_reveals:
            continue
        if seat != agent_seat:
            raise TestFailure(f"{label}: cards leaked for seat {seat} at {path}: {cards}")


def wait_for_turn_or_event(client, game_id, token, since):
    response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
    check(response.get("waitTimedOut") is not True, "long-poll delivered an event (no timeout)")
    return response


def play_hand_to_end(client, game_id, token, since, on_agent_turn=None, max_turns=200):
    """Polls/acts until the next hand_result or terminal status. Returns (response, since)."""
    turns = 0
    while True:
        response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
        since = response.get("revision", since)
        status = response.get("status")
        if status != "running":
            return response, since
        if response.get("messageType") == "hand_result":
            return response, since
        if not response.get("yourTurn"):
            continue
        turns += 1
        if turns > max_turns:
            raise TestFailure("too many agent turns without a hand result")
        action, amount = on_agent_turn(response["state"]) if on_agent_turn else ("call", None)
        client.act(game_id, token, action, amount)


def always_call_or_check(state):
    action_state = state.get("actionState") or {}
    if action_state.get("canCheck"):
        return ("check", None)
    return ("call", None)


def test_health_and_creation(client):
    print("== health + creation ==")
    health = client._request("GET", "/health")
    check(health.get("ok") is True, "health endpoint responds")
    game = client.create_game(agent_name="TestAgent", bots=3, chips=500)
    check(game.get("gameId"), "game created with id")
    check(game.get("seatToken"), "game created with seat token")
    check(game.get("seatIndex") == 0, "agent sits at seat 0")
    state = game.get("state") or {}
    check(len(state.get("players", [])) == 4, "1 agent + 3 bots seated")
    check("holeCards" not in state, "initial state carries no hole cards before the deal")
    return game


def test_full_game_and_leak_audit(client):
    print("== full game + leak audit ==")
    game = client.create_game(agent_name="LeakAuditor", bots=2, chips=300)
    game_id, token = game["gameId"], game["seatToken"]
    since = 0
    hand_results = 0
    game_over = None
    guard = 0

    while game_over is None and guard < 10000:
        guard += 1
        response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
        check(response.get("waitTimedOut") is not True, "event delivered")
        since = response.get("revision", since)
        is_hand_result = response.get("messageType") == "hand_result"
        try:
            audit_no_card_leaks(response, f"game {game_id} response", allow_reveals=is_hand_result)
        except TestFailure:
            print("RAW FAILING RESPONSE:")
            print(json.dumps(response, indent=1)[:4000])
            raise

        # Walk every message in order; only the terminal MESSAGE ends the walk. status may already
        # say "finished" while older messages (the bot-only remainder ran synchronously) are still
        # waiting to be consumed.
        if is_hand_result:
            hand_results += 1
            state = response["state"]
            if state.get("hadShowdown"):
                revealed = [p for p in state["players"] if p.get("holeCards")]
                check(len(revealed) >= 2, "showdown reveals hole cards of >= 2 players")
            continue
        if response.get("messageType") in ("game_over", "error", "aborted"):
            print(f"    [trace] terminal at guard={guard}: type={response.get('messageType')} "
                  f"rev={response.get('revision')} status={response.get('status')} "
                  f"err={response.get('errorMessage')}")
            game_over = response
            break
        if response.get("yourTurn"):
            action, amount = always_call_or_check(response["state"])
            client.act(game_id, token, action, amount)

    check(game_over is not None, "tournament reached game over")
    check(hand_results >= 1, f"saw {hand_results} hand results")
    history = client.history(game_id, token)
    check(
        len(history.get("hands", [])) == hand_results,
        f"history endpoint matches observed hands ({len(history.get('hands', []))} in history vs {hand_results} observed)",
    )
    audit_no_card_leaks(history, "history", allow_reveals=True)
    print(f"  ok: game finished, status={game_over.get('status')}, "
          f"champion={game_over.get('champion')}")
    return game_id


def test_no_turn_timer(client):
    print("== no turn timer (long thinking) ==")
    game = client.create_game(agent_name="SlowThinker", bots=2, chips=1000)
    game_id, token = game["gameId"], game["seatToken"]
    since = 0
    slept = False
    guard = 0
    finished = False

    while not finished and guard < 10000:
        guard += 1
        response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
        since = response.get("revision", since)
        if response.get("messageType") == "hand_result":
            continue
        if response.get("messageType") in ("game_over", "error", "aborted"):
            finished = True
            break
        if response.get("yourTurn"):
            if not slept:
                print("  sleeping 12s before acting (simulating a slow agent)...")
                time.sleep(12)
                slept = True
            action, amount = always_call_or_check(response["state"])
            client.act(game_id, token, action, amount)

    check(slept, "agent took a 12s think break mid-hand")
    check(True, "server accepted actions after long thinking (no countdown enforced)")

    # Clean up this game so the suite does not run forever.
    request = urllib.request.Request(f"{BASE_URL}/games/{game_id}", method="DELETE")
    urllib.request.urlopen(request, timeout=30)
    print("  ok: game aborted via DELETE")


def test_action_validation(client):
    print("== action validation ==")
    game = client.create_game(agent_name="Validator", bots=2, chips=1000)
    game_id, token = game["gameId"], game["seatToken"]
    since = 0
    validated_wrong_turn = False
    validated_bad_token = False
    validated_bad_check = False
    validated_clamped_raise = False
    saw_turn = False
    guard = 0

    while guard < 10000:
        guard += 1
        response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
        since = response.get("revision", since)
        if response.get("messageType") == "hand_result":
            continue
        if response.get("messageType") in ("game_over", "error", "aborted"):
            break
        if not response.get("yourTurn"):
            continue
        if validated_bad_token and validated_wrong_turn and validated_bad_check \
                and validated_clamped_raise:
            break  # all validation cases exercised; stop playing this game
        saw_turn = True
        action_state = response["state"]["actionState"]

        if not validated_bad_token:
            try:
                client.act(game_id, "wrong-token", "fold")
                raise TestFailure("bad token was accepted")
            except PokerApiError as error:
                check(error.status == 401, "bad token rejected with 401")
                validated_bad_token = True

        if not validated_wrong_turn:
            turn_revision = response.get("revision")
            client.act(game_id, token, "fold", turn_revision=turn_revision)  # must succeed
            try:
                # Echoing the same turn revision must fail deterministically, even if the worker
                # already advanced to the next agent turn while this request was in flight.
                client.act(game_id, token, "fold", turn_revision=turn_revision)
                raise TestFailure("double action for the same turn was accepted")
            except PokerApiError as error:
                check(error.status == 409, "second action on same turn rejected with 409")
                validated_wrong_turn = True
            continue

        if not validated_bad_check and action_state.get("needToCall", 0) > 0:
            try:
                client.act(game_id, token, "check")
                raise TestFailure("check was accepted while facing a bet")
            except PokerApiError as error:
                check(error.status == 400, "impossible check rejected with 400")
                validated_bad_check = True
            client.act(game_id, token, "call")
            continue

        if not validated_clamped_raise and action_state.get("canCheck"):
            tiny_raise = 1
            result = client.act(game_id, token, "raise", tiny_raise)
            normalized = result.get("normalized", {})
            check(
                normalized.get("action") in ("raise", "allin")
                and (normalized.get("amount", 0) >= action_state.get("minRaise", 0)
                     or normalized.get("action") == "allin"),
                f"raise amount {tiny_raise} clamped up to legal minimum ({normalized})",
            )
            validated_clamped_raise = True
            continue

        action, amount = always_call_or_check(response["state"])
        client.act(game_id, token, action, amount)

    check(saw_turn, "agent got at least one turn")
    check(validated_bad_token and validated_wrong_turn and validated_bad_check
          and validated_clamped_raise, "all validation cases exercised")
    request = urllib.request.Request(f"{BASE_URL}/games/{game_id}", method="DELETE")
    urllib.request.urlopen(request, timeout=30)


def test_unknown_game_404(client):
    print("== 404 handling ==")
    try:
        client.state("00000000-0000-0000-0000-000000000000", "whatever")
        raise TestFailure("unknown game returned 200")
    except PokerApiError as error:
        check(error.status == 404, "unknown game id rejected with 404")


def insights_request(client, game_id, token, samples=None):
    query = f"token={token}"
    if samples is not None:
        query += f"&samples={samples}"
    return client._request("GET", f"/games/{game_id}/insights?{query}")


def test_human_seat_duel(client):
    print("== human seat duel (agent vs human, heads-up) ==")
    game_id = None
    try:
        game = client._request("POST", "/games", {
            "agentName": "DuelAgent",
            "botCount": 0,
            "humanSeat": True,
            "humanName": "Player1",
            "startingChips": 1000,
        })
        game_id, agent_tok = game["gameId"], game["seatToken"]
        human_tok = game.get("humanSeatToken")
        check(human_tok and human_tok != agent_tok, "distinct human seat token issued")
        state = game.get("state") or {}
        check(len(state.get("players", [])) == 2, "heads-up table has exactly 2 seats")
        check(any(p.get("name") == "Player1" for p in state.get("players", [])),
              "human seat named from config")

        try:
            client._request("POST", "/games", {"agentName": "X", "botCount": 0, "startingChips": 500})
            raise TestFailure("botCount 0 accepted without humanSeat")
        except PokerApiError as error:
            check(error.status == 400, "botCount 0 without humanSeat rejected (400)")

        since = 0
        hands_done = 0
        scoped_ok = False
        guard = 0
        while hands_done < 2 and guard < 400:
            guard += 1
            resp = client.state(game_id, agent_tok, since=since, wait=True, wait_timeout_ms=600000)
            check(resp.get("waitTimedOut") is not True, "duel event delivered")
            since = resp.get("revision", since)
            message_type = resp.get("messageType")
            try:
                audit_no_card_leaks(resp, "duel agent view",
                                    allow_reveals=message_type == "hand_result", agent_seat=0)
            except TestFailure:
                print(json.dumps(resp, indent=1)[:3000])
                raise
            if message_type in ("game_over", "error", "aborted"):
                break
            if message_type == "hand_result":
                hands_done += 1
                continue
            state = resp["state"]
            if state.get("yourTurn"):
                me = next((p for p in state["players"] if p["seatIndex"] == 0), {})
                opponent = next((p for p in state["players"] if p["seatIndex"] != 0), {})
                if me.get("holeCards") and not opponent.get("holeCards"):
                    scoped_ok = True
                try:
                    client.act(game_id, human_tok, "call")
                    raise TestFailure("human action accepted during agent turn")
                except PokerApiError as error:
                    check(error.status == 409, "human action rejected during agent turn (409)")
                action_state = state.get("actionState") or {}
                action = "check" if action_state.get("canCheck") else "call"
                client.act(game_id, agent_tok, action)
            elif state.get("humanTurn"):
                me = next((p for p in state["players"] if p["seatIndex"] == 1), {})
                opponent = next((p for p in state["players"] if p["seatIndex"] != 1), {})
                if me.get("holeCards") and not opponent.get("holeCards"):
                    scoped_ok = True
                human_view = client.state(game_id, human_tok)
                audit_no_card_leaks(human_view, "duel human view",
                                    allow_reveals=False, agent_seat=1)
                action_state = state.get("actionState") or {}
                action = "check" if action_state.get("canCheck") else "call"
                client.act(game_id, human_tok, action)

        check(hands_done >= 1, "duel completed at least one full hand")
        check(scoped_ok, "hole-card scoping verified from both seat views")
    finally:
        if game_id:
            try:
                client._request("DELETE", f"/games/{game_id}")
            except Exception:
                pass


def test_insights_endpoint(client):
    print("== insights endpoint (LLM decision tool) ==")
    try:
        game = client.create_game(agent_name="InsightsAgent", bots=2, chips=1000)
        game_id, token = game["gameId"], game["seatToken"]

        try:
            client._request("GET", f"/games/{game_id}/insights?token=wrong-token")
            raise TestFailure("insights accepted a bad token")
        except PokerApiError as error:
            check(error.status == 401, "insights requires the seat token (401)")

        since = 0
        hand_results = 0
        seen_postflop_equity = False
        guard = 0
        # Play until a flop is actually seen (or the tournament ends): with deep stacks most hands
        # reach the flop, but a preflop all-in war can legitimately end several hands early.
        while guard < 1500 and not seen_postflop_equity:
            guard += 1
            response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
            check(response.get("waitTimedOut") is not True, "event delivered for insights walk")
            since = response.get("revision", since)
            message_type = response.get("messageType")
            if message_type in ("game_over", "error", "aborted"):
                break
            if message_type == "hand_result":
                hand_results += 1
                continue
            if not response.get("yourTurn"):
                continue
            state = response["state"]
            insights = insights_request(client, game_id, token, samples=2000)
            audit_no_card_leaks(insights, "insights payload")
            check(insights.get("ok") is True, "insights payload ok")
            check(insights.get("handId") == state.get("handId"), "insights matches current hand")
            check(isinstance(insights.get("headline"), list) and insights["headline"],
                  "insights carries a compact headline")
            equity = insights.get("equity") or {}
            if (state.get("communityCards") or []):
                check(equity.get("available") is True, "equity available once cards are out")
                if len(state.get("communityCards") or []) >= 3:
                    seen_postflop_equity = True
                check(0 <= equity.get("equityPct", -1) <= 100, "equityPct within [0,100]")
                check(equity.get("opponentCount", 0) >= 1, "equity sampled against live opponents")
                check(equity.get("samples") == 2000, "requested sample count honored")
                check(
                    equity.get("stderrPct", 100) < 100,
                    "stderr reported alongside equity",
                )
                vs_range = equity.get("vsRangePct")
                check(vs_range is None or 0 <= vs_range <= 100,
                      "vsRangePct within [0,100] when present")
                if equity.get("rangeSamples") is not None:
                    check(equity["rangeSamples"] <= 8000,
                          "range sampling capped independently of random-equity samples")
            economics = insights.get("economics") or {}
            check(economics.get("pot") == state.get("pot"), "economics pot matches state")
            check("potOddsPct" in economics and "spr" in economics, "economics carries odds + SPR")
            position = insights.get("position") or {}
            check(position.get("seatClass") in
                  ("button", "smallBlind", "bigBlind", "early", "middle", "cutoff"),
                  "position seatClass classified")
            blinds = insights.get("blinds") or {}
            check(blinds.get("bigBlind") == state.get("bigBlind"), "blinds mirror state")

            preflop = insights.get("preflop")
            if state.get("phase") == "preflop":
                check(preflop is not None, "preflop decision table present before the flop")
                check(preflop.get("spot") in
                      ("unopened", "unopenedCheck", "facingLimp", "facingRaise",
                       "facing3Bet", "facingAllIn"),
                      f"preflop spot classified: {preflop.get('spot')}")
                check(preflop.get("suggestedAction") in
                      ("fold", "check", "call", "raise", "allin"),
                      "preflop suggested action is a legal action family")
                check(0 < preflop.get("topPercent", 0) <= 100,
                      "preflop hand percentile in (0,100]")
                check(preflop.get("handClass") and
                      2 <= len(preflop["handClass"]) <= 3,
                      "preflop hand class rendered")
            else:
                check(preflop is None, "preflop table omitted after the flop")

            draws = insights.get("draws")
            board_cards = state.get("communityCards") or []
            if len(board_cards) >= 3:
                check(draws is not None and draws.get("available") is True,
                      "draw detector available postflop")
                outs = draws.get("outs") or {}
                check(isinstance(outs.get("clean"), int) and outs["clean"] >= 0,
                      "clean outs reported")
                check(draws.get("unknownCardCount") == 52 - 2 - len(board_cards),
                      "draw unknown-card count matches public cards")
                if draws.get("flushDraw"):
                    check(draws["flushDraw"].get("outs") == 9,
                          "flush draw reports 9 outs")
                if board_cards:
                    check(0 <= draws.get("byRiverCompletionPct", -1) <= 100,
                          "draw completion percentage in [0,100]")
            else:
                check(draws is None, "draw detector omitted preflop")

            sizing = insights.get("sizing")
            check(sizing is not None, "sizing helper present while seated")
            action_state = state.get("actionState") or {}
            check(sizing.get("legal", {}).get("needToCall") == action_state.get("needToCall"),
                  "sizing legal block mirrors actionState")
            check(isinstance(sizing.get("amountSemantics"), str) and
                  "additional chips" in sizing["amountSemantics"],
                  "sizing spells out amount semantics")
            for option in sizing.get("options") or []:
                check(option.get("raiseToTotal") == sizing.get("roundBet", 0) + option.get("amount", 0),
                      "sizing raiseToTotal = roundBet + amount")
                check(option.get("amount", 0) >= 0, "sizing amount is non-negative")
                check(option.get("amount", 0) <= sizing.get("legal", {}).get("maxRaiseAmount", 0),
                      "sizing option within max raise")

            action = "check" if action_state.get("canCheck") else "call"
            client.act(game_id, token, action)

        # Reads are built from the hand_result stream, so they must exist once any hand completed,
        # regardless of whether the agent got an acting turn in later hands.
        insights = insights_request(client, game_id, token, samples=2000)
        audit_no_card_leaks(insights, "final insights payload")
        equity_section = insights.get("equity") or {}
        agent_busted = equity_section.get("available") is False and \
            equity_section.get("reason") == "agent_busted_or_absent"
        # A preflop all-in war can end every hand before the flop; if the agent busted that way,
        # there was never a postflop turn to observe and that is a pass, not a failure.
        check(seen_postflop_equity or agent_busted,
              "postflop equity observed, or agent busted before any flop")
        if hand_results >= 1:
            reads = insights.get("reads") or []
            check(len(reads) >= 1, "reads populated after completed hands")
            for record in reads:
                check(0 <= record.get("vpipPct", -1) <= 100, "reads vpipPct plausible")
                check(record.get("seatIndex") != 0,
                      f"reads never include the agent seat: {record}")

        # Sampling clamp: oversized request is capped, not rejected.
        insights = insights_request(client, game_id, token, samples=999999)
        check((insights.get("equity") or {}).get("samples") in (None, 25000),
              "oversized sample request is clamped to 25000")

        # Post-game audit endpoint: every decision in this walk was preceded by an insights call.
        report = client._request("GET", f"/games/{game_id}/report?token={token}")
        audit_no_card_leaks(report, "report payload")
        check(report.get("ok") is True, "report endpoint responds")
        check(report.get("handsPlayed") == hand_results,
              "report hand count matches observed hand results")
        check(len(report.get("hands") or []) == hand_results,
              "report per-hand summaries match hand count")
        decisions = report.get("decisions") or {}
        check(isinstance(decisions.get("total"), int), "report decision count present")
        if decisions.get("total", 0) > 0:
            check(decisions.get("withInsights") == decisions.get("total"),
                  "every audited decision was covered by an insights call")
            check(decisions.get("coveragePct") == 100.0,
                  "insights coverage is 100% in the disciplined walk")
            check(len(report.get("decisionLog") or []) >= 1,
                  "report includes a compact decision trail")
        check(isinstance(report.get("violations"), list),
              "report exposes a violations list")
        check(isinstance(report.get("flagCounts"), dict),
              "report exposes violation counts")
        try:
            client._request("GET", f"/games/{game_id}/report?token=wrong-token")
            raise TestFailure("report accepted a bad token")
        except PokerApiError as error:
            check(error.status == 401, "report requires the seat token (401)")
    finally:
        try:
            client._request("DELETE", f"/games/{game_id}")
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deno", default="deno")
    args = parser.parse_args()

    import os
    import tempfile

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    print(f"starting Deno server on port {PORT} (repo root: {repo_root})")
    # Server output goes to a file: an undrained stdout pipe would fill up and BLOCK the server
    # mid-game once its log output exceeds the pipe buffer.
    server_log = tempfile.NamedTemporaryFile(
        "w", suffix="-poker-server.log", encoding="utf-8", delete=False,
    )
    server = subprocess.Popen(
        [args.deno, "run", "--allow-net", "--allow-read", "server/main.js", f"--port={PORT}"],
        cwd=repo_root,
        stdout=server_log,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        deadline = time.time() + 20
        ready = False
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"{BASE_URL}/health", timeout=2)
                ready = True
                break
            except Exception:
                if server.poll() is not None:
                    raise TestFailure(f"server exited early; see {server_log.name}")
                time.sleep(0.3)
        check(ready, "server became healthy")

        client = AgentPokerClient(BASE_URL)
        test_health_and_creation(client)
        test_unknown_game_404(client)
        test_insights_endpoint(client)
        test_human_seat_duel(client)
        test_full_game_and_leak_audit(client)
        test_no_turn_timer(client)
        test_action_validation(client)

        print("\nALL TESTS PASSED")
    except Exception as error:
        print(f"\nTEST FAILURE: {error}")
        raise
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:
            server.kill()
        server_log.close()
        with open(server_log.name, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
        tail = "".join(lines[-25:])
        if tail:
            print("--- server log tail ---")
            print(tail)
        try:
            os.unlink(server_log.name)
        except PermissionError:
            pass


if __name__ == "__main__":
    main()
