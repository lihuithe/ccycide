import os, sys, paramiko
host = os.environ["SSH_HOST"]
c = paramiko.SSHClient()
# 严格校验主机密钥：只信任 known_hosts 里已有的，未知主机直接报错（不自动信任）
kh = os.path.expanduser(os.environ.get("SSH_KNOWN_HOSTS", "~/.ssh/known_hosts"))
if os.path.exists(kh): c.load_host_keys(kh)
c.set_missing_host_key_policy(paramiko.RejectPolicy())
user = os.environ.get("SSH_USER", "root")
kw = dict(hostname=host, username=user, timeout=20)
if os.environ.get("SSH_PW"): kw.update(password=os.environ["SSH_PW"], look_for_keys=False, allow_agent=False)
else: kw.update(key_filename=os.environ["SSH_KEY"])
try:
    c.connect(**kw)
except (paramiko.SSHException, OSError) as e:
    if "not found in known_hosts" in str(e):
        sys.exit(f"未知主机 {host}：不会自动信任。请先执行 ssh-keyscan -H {host} >> {kh} 并核对指纹后重试。")
    raise
cmd = sys.argv[1]
stdin, out, err = c.exec_command(cmd, timeout=int(os.environ.get("SSH_TIMEOUT", "300")))
sys.stdout.buffer.write(out.read()); sys.stderr.buffer.write(err.read())
sys.exit(out.channel.recv_exit_status())
