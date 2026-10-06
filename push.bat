@echo off

set /p "message=コミットメッセージ: "

git add .
git commit -m "%message%"

git push origin main