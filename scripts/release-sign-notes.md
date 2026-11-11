# 签名速查

完整流程见 `docs/发布流程.md`。这里只放手工操作时要用的命令。

## updater 密钥

```bash
cd apps/desktop
npm run tauri -- signer generate -w ~/.tauri/rterm-updater.key    # 提示输入密码；生成 .key 与 .key.pub
cat ~/.tauri/rterm-updater.key.pub                                 # 整个文件内容写进 tauri.conf.json 的 plugins.updater.pubkey
```

私钥内容（`.key` 文件全文）与密码分别存入 secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥另外离线备份两份。

## 给任意文件签名（命令行版压缩包）

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/rterm-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='...'
cd apps/desktop && npm run tauri -- signer sign ../../dist/rterm-cli-0.2.0-x86_64-unknown-linux-musl.tar.gz
# 生成同名 .sig，release-admin.sh publish 会把它作为 signature 登记
```

## Windows 证书转 base64（PFX 方式）

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('codesign.pfx')) | Set-Clipboard    # 粘贴到 secret WINDOWS_CERTIFICATE
```

## macOS 证书转 base64

```bash
base64 -i DeveloperID.p12 | pbcopy        # 粘贴到 secret APPLE_CERTIFICATE
security find-identity -v -p codesigning  # 查看 APPLE_SIGNING_IDENTITY 的完整名称
```

## 验证已签名的安装包

```powershell
# Windows：安装后对安装目录下所有 exe / dll 逐个验证（包括 rterm-cli.exe、OpenConsole.exe）
Get-ChildItem "$env:LOCALAPPDATA\Programs\RTerm" -Recurse -Include *.exe,*.dll | ForEach-Object { signtool verify /pa $_.FullName }
```

```bash
# macOS
codesign --verify --deep --strict --verbose=2 /Applications/RTerm.app
spctl -a -vv /Applications/RTerm.app          # 期望：accepted, source=Notarized Developer ID
xcrun stapler validate /Applications/RTerm.app
```

```bash
# Linux 与所有平台：核对下载完整性
sha256sum -c SHA256SUMS.txt        # macOS 用 shasum -a 256 -c SHA256SUMS.txt
```
