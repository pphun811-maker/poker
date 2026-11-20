@echo off
cd /d "%~dp0"
netstat -ano | findstr ":5500" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo 检测到服务器已在运行，直接打开游戏页面。
    start "" http://127.0.0.1:5500/index.html
    goto :eof
)
start "" cmd /c "ping -n 2 127.0.0.1 >nul & start "" http://127.0.0.1:5500/index.html"
echo 德州扑克已启动，浏览器即将自动打开。
echo 玩完后直接关闭本窗口即可停止服务器。
python -m http.server 5500
