#!/usr/bin/env python3
"""Reference HTTP client for the agent poker API, plus a simple demo strategy.

Run a full demo game:

    python exampleAgent.py --base-url http://127.0.0.1:8899 --bots 3 --chips 500

Options:
    --think-seconds N   Sleep N seconds before every agent action. The table has no turn timer,
                        so long thinking never costs anything; this just proves it works.

The demo strategy is intentionally naive. It exists to show the protocol loop:
    wait for your turn -> read the snapshot -> submit an action -> repeat.
Replace decide() with your own logic to make it a real agent.
"""

import argparse
import json
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://127.0.0.1:8899"


class PokerApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


class AgentPokerClient:
    """Minimal stdlib-only client. Every method returns the parsed JSON response."""

    def __init__(self, base_url=DEFAULT_BASE_URL):
        self.base_url = base_url.rstrip("/")

    def _request(self, method, path, payload=None, timeout=1200):
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise PokerApiError(error.code, error.read().decode("utf-8")) from error

    def create_game(self, agent_name="Agent", bots=5, chips=2000):
        return self._request("POST", "/games", {
            "agentName": agent_name,
            "botCount": bots,
            "startingChips": chips,
        })

    def state(self, game_id, token, since=None, wait=False, wait_timeout_ms=600000):
        query = f"token={token}"
        if since is not None:
            query += f"&since={since}"
        if wait:
            query += "&wait=1"
            query += f"&waitTimeout={wait_timeout_ms}"
        return self._request("GET", f"/games/{game_id}/state?{query}")

    def act(self, game_id, token, action, amount=None, turn_revision=None):
        payload = {"token": token, "action": action}
        if amount is not None:
            payload["amount"] = amount
        if turn_revision is not None:
            payload["turnRevision"] = turn_revision
        return self._request("POST", f"/games/{game_id}/action", payload)

    def history(self, game_id, token):
        return self._request("GET", f"/games/{game_id}/history?token={token}")


def agent_hole_cards(state):
    agent_seat = state.get("agentSeatIndex", 0)
    for player in state.get("players", []):
        if player.get("seatIndex") == agent_seat:
            return player.get("holeCards") or []
    return []


def card_rank(card):
    return "23456789TJQKA".index(card[0])


def is_pocket_pair(cards):
    return len(cards) == 2 and cards[0][0] == cards[1][0]


def is_suited(cards):
    return len(cards) == 2 and cards[0][1] == cards[1][1]


def preflop_score(cards):
    """0-20 toy score. Only used to make the demo agent play coherent-ish cards."""
    if len(cards) < 2:
        return 0
    high, low = sorted((card_rank(cards[0]), card_rank(cards[1])), reverse=True)
    score = high + 1
    if is_pocket_pair(cards):
        return max(score * 2, 6)
    if is_suited(cards):
        score += 1.5
    gap = high - low
    if gap == 1:
        score += 1
    elif gap == 2:
        score += 0.5
    return score


def decide(state):
    """Demo strategy: loose-tight preflop via toy score, then call/bet by feel. Not good poker."""
    action_state = state.get("actionState") or {}
    need_to_call = action_state.get("needToCall", 0)
    can_check = action_state.get("canCheck", False)
    cards = agent_hole_cards(state)
    phase = state.get("phase")
    pot = state.get("pot", 0)
    big_blind = max(state.get("bigBlind", 20), 1)

    if phase == "preflop":
        score = preflop_score(cards)
        if score >= 13:
            return ("raise", action_state.get("minRaise", big_blind * 2))
        if score >= 8 or is_pocket_pair(cards):
            return ("call", None) if need_to_call > 0 else ("raise", action_state.get("minRaise", big_blind))
        if need_to_call <= big_blind and score >= 6:
            return ("call", None)
        return ("fold", None)

    if can_check:
        # Thin value bet half the time, otherwise check.
        return ("check", None)

    # Facing a bet postflop: call small bets, fold big ones. Demo only.
    call_ratio = need_to_call / max(pot + need_to_call, 1)
    if call_ratio <= 0.35:
        return ("call", None)
    return ("fold", None)


def run_game(client, game, think_seconds=0.0, max_turns=500):
    game_id = game["gameId"]
    token = game["seatToken"]
    since = game.get("revision", 0)
    turns = 0

    while turns < max_turns:
        response = client.state(game_id, token, since=since, wait=True, wait_timeout_ms=600000)
        since = response.get("revision", since)
        message_type = response.get("messageType")
        state = response.get("state") or {}

        # Process the delivered message before the terminal-status check: a final burst of
        # hand_result + game_over may deliver a hand_result while the game already finished.
        if message_type == "hand_result":
            print(
                f"--- hand {state.get('handId')} finished: "
                f"pot={state.get('totalPot')} winners={[w['name'] for w in state.get('winners', [])]}"
            )
            continue

        # Only the terminal MESSAGE ends the game; status may say "finished" while older messages
        # (bot-only remainder ran synchronously) are still in the stream.
        if message_type in ("game_over", "error", "aborted"):
            print(f"Game over. status={response.get('status')} champion={response.get('champion')}")
            return response

        if not response.get("yourTurn"):
            continue

        turns += 1
        if think_seconds > 0:
            print(f"your turn (hand {state.get('handId')}, {state.get('phase')}): "
                  f"cards={agent_hole_cards(state)} board={state.get('communityCards')} "
                  f"pot={state.get('pot')} toCall={(state.get('actionState') or {}).get('needToCall', 0)}"
                  f" -- thinking {think_seconds}s")
            time.sleep(think_seconds)

        action, amount = decide(state)
        result = client.act(game_id, token, action, amount, turn_revision=response.get("revision"))
        print(f"  submitted {result.get('normalized')} (you asked for {action} {amount if amount is not None else ''})")

    print("max_turns reached; aborting game")
    return None


def main():
    parser = argparse.ArgumentParser(description="Demo agent for the poker HTTP API")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--name", default="Agent")
    parser.add_argument("--bots", type=int, default=3)
    parser.add_argument("--chips", type=int, default=500)
    parser.add_argument("--think-seconds", type=float, default=0.0)
    args = parser.parse_args()

    client = AgentPokerClient(args.base_url)
    game = client.create_game(agent_name=args.name, bots=args.bots, chips=args.chips)
    print(f"Created game {game['gameId']} (seat {game['seatIndex']}, token kept in memory)")
    try:
        run_game(client, game, think_seconds=args.think_seconds)
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"{client.base_url}/games/{game['gameId']}",
                method="DELETE",
            ), timeout=30)
        except Exception:
            pass


if __name__ == "__main__":
    main()
