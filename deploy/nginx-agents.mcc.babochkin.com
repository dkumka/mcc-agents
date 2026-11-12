# mcc agents: https://agents.mcc.babochkin.com
#   /api/*, /ws -> unix:/run/mcc-agents/agentd.sock (mcc-agentd.service)
#   остальное   -> 127.0.0.1:3110 (mcc-agents-web.service, Next.js)
# Вход — тот же логин и пароль, что у code.mcc / ssh.mcc / домашней страницы (/etc/nginx/code.htpasswd).
# Иконки и manifest — без пароля (iOS «На экран Домой» берёт их без авторизации).
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name agents.mcc.babochkin.com;

    ssl_certificate     /etc/ssl/mcc/fullchain.pem;
    ssl_certificate_key /etc/ssl/mcc/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    auth_basic "mcc";
    auth_basic_user_file /etc/nginx/code.htpasswd;

    client_max_body_size 60m;

    location /api/ {
        proxy_pass http://unix:/run/mcc-agents/agentd.sock;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization "";
        proxy_read_timeout 120s;
    }

    location = /ws {
        proxy_pass http://unix:/run/mcc-agents/agentd.sock;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Authorization "";
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        proxy_buffering off;
    }

    location ~ ^/(manifest\.webmanifest|icon|apple-icon|favicon\.ico)$ {
        auth_basic off;
        proxy_pass http://127.0.0.1:3110;
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://127.0.0.1:3110;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Authorization "";
        proxy_read_timeout 1d;
    }
}
