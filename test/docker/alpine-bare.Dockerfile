# OpenSSH plus the sqlite3 CLI but no Python: exercises the "helper cannot run" error path.
ARG BASE=alpine:3.20
FROM ${BASE}
RUN apk add --no-cache openssh sqlite && ssh-keygen -A
RUN adduser -D -s /bin/ash bareuser && echo 'bareuser:secret' | chpasswd \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
