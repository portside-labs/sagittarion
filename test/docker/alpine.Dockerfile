# Real OpenSSH server with python3 and sqlite3, and three users whose login
# shells differ: busybox ash, bash (with a chatty rc file) and fish. The base
# can be any Alpine-flavoured image (see build.mjs --base).
ARG BASE=alpine:3.20
FROM ${BASE}
RUN apk add --no-cache openssh python3 sqlite bash fish && ssh-keygen -A
RUN adduser -D -s /bin/ash ashuser && echo 'ashuser:secret' | chpasswd \
 && adduser -D -s /bin/bash bashuser && echo 'bashuser:secret' | chpasswd \
 && adduser -D -s /usr/bin/fish fishuser && echo 'fishuser:secret' | chpasswd \
 && mkdir -p /home/fishuser/data /home/fishuser/.ssh
# Chatty rc files: fish runs config.fish for every command, bash reads BASH_ENV.
RUN mkdir -p /home/fishuser/.config/fish \
 && echo 'echo "rc noise: welcome to fish"' > /home/fishuser/.config/fish/config.fish \
 && echo 'echo "rc noise: welcome to bash"' > /home/bashuser/.bashrc
COPY sample.db /home/ashuser/sample.db
COPY sample.db /home/bashuser/sample.db
COPY sample.db /home/fishuser/data/sample.db
COPY authorized_keys /home/fishuser/.ssh/authorized_keys
RUN chown -R ashuser:ashuser /home/ashuser \
 && chown -R bashuser:bashuser /home/bashuser \
 && chown -R fishuser:fishuser /home/fishuser \
 && chmod 700 /home/fishuser/.ssh && chmod 600 /home/fishuser/.ssh/authorized_keys \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
