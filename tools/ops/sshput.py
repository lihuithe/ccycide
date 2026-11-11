"""用 SFTP 上传单个文件：python -I sshput.py 本地路径 远程路径。环境变量同 sshrun.py（SSH_HOST / SSH_KEY 或 SSH_PW）。"""
import os, sys, paramiko
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
kw = dict(hostname=os.environ["SSH_HOST"], username=os.environ.get("SSH_USER", "root"), timeout=20)
if os.environ.get("SSH_PW"): kw.update(password=os.environ["SSH_PW"], look_for_keys=False, allow_agent=False)
else: kw.update(key_filename=os.environ["SSH_KEY"])
c.connect(**kw)
s = c.open_sftp()
s.put(sys.argv[1], sys.argv[2])
print("uploaded", sys.argv[1], "->", sys.argv[2], os.path.getsize(sys.argv[1]), "bytes")
