import os, sys, paramiko
host, user = os.environ["SSH_HOST"], os.environ.get("SSH_USER", "root")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
kw = dict(hostname=host, username=user, timeout=20)
if os.environ.get("SSH_PW"): kw.update(password=os.environ["SSH_PW"], look_for_keys=False, allow_agent=False)
else: kw.update(key_filename=os.environ["SSH_KEY"])
c.connect(**kw)
cmd = sys.argv[1]
stdin, out, err = c.exec_command(cmd, timeout=int(os.environ.get("SSH_TIMEOUT", "300")))
sys.stdout.buffer.write(out.read()); sys.stderr.buffer.write(err.read())
sys.exit(out.channel.recv_exit_status())
