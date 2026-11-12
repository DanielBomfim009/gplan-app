@echo off
rem Gera v2	ailwind.css a partir das classes usadas em v2\index.html e v2pp.js.
rem Precisa do Node instalado. Rode depois de mexer nas telas.
cd /d "%~dp0"
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i input.css -o ..2	ailwind.css --minify
pause
