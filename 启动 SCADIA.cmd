@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
echo ============================================
echo   开诚智枢 SCADIA 正在启动...
echo   访问地址: http://127.0.0.1:1881
echo   默认账号: admin / 123456
echo   使用手册: 界面右上角“使用手册”图标，或 帮助\\开诚智枢SCADIA帮助.chm
echo   关闭本窗口即停止服务。
echo ============================================
start "" cmd /c "timeout /t 4 >nul && start http://127.0.0.1:1881"
"%NODE%" "%~dp0source\server\main.js" --port 1881 --userDir "%~dp0project"
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul