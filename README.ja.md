# TianForge pi

[English](./README.md) | [简体中文](./README.zh-CN.md)

[pi コーディングエージェント](https://github.com/badlogic/pi-mono) を基盤にしたローカル開発ワークスペースです。TianForge pi はローカルの pi セッションファイルを読み込み、複数プロジェクトのセッション、リアルタイムチャット、Agent ターミナル、Git レビュー、プロジェクトファイルをブラウザにまとめます。

![TianForge pi では、CLI と同じ pi セッションを、構造化された Markdown、ツール呼び出し、プロジェクトナビゲーションとともに表示できます](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

CLI と TianForge pi で同じ pi セッションを利用できます。構造化されたツール呼び出し、読みやすい Markdown、セッション閲覧、整理された結果表示を備えています。

## クイックスタート

TianForge pi には Node.js 22.19.0 以降が必要です。現在のバージョンは `node --version` で確認できます。

**インストールせずに実行：**

```bash
npx @agegr/pi-web@latest
```

**またはグローバルにインストール：**

```bash
npm install -g @agegr/pi-web
pi-web
```

続いて [http://127.0.0.1:30141](http://127.0.0.1:30141) を開きます。サーバーの準備が整うと、CLI はブラウザを自動的に開こうとします。TianForge pi はデフォルトで `127.0.0.1` のみをリッスンします。

**オプション：**

```bash
pi-web --port 8080              # カスタムポート
pi-web --hostname 0.0.0.0       # 信頼できるネットワークに公開
pi-web -p 8080 -H 0.0.0.0       # オプションを組み合わせる
pi-web --no-open                # ブラウザを自動的に開かない

PORT=8080 pi-web                # 環境変数にも対応
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # ネットワーク公開を明示的に有効化
PI_WEB_NO_OPEN=1 pi-web         # バックグラウンドサービスとして実行する場合に便利
```

`PI_WEB_PASSWORD` で TianForge pi のパスワード認証を有効にできます。loopback 以外へバインドする場合は必須です。インターネットへ直接公開せず、HTTPS と信頼できるネットワークを使用してください。

ログインセッションはパスワードから派生した鍵で署名されるため、`PI_WEB_PASSWORD` を変更するとすべてのブラウザがログアウトされます。0.8.1 以前からアップグレードした場合も、一度だけ全デバイスで再ログインが必要です。

### 許可するホスト

DNS リバインディング攻撃を防ぐため、TianForge pi は `Host` ヘッダーがこのマシンに属するリクエストにのみ応答します：`localhost`、ループバックアドレス、マシンのホスト名と `<ホスト名>.local`、現在の LAN / Tailscale IP アドレス。Tailscale Serve の名前（`*.ts.net`）はデフォルトで許可されます。

独自ドメイン、リバースプロキシ、DNS エイリアスなど別の名前でアクセスする場合は、`PI_WEB_ALLOWED_HOSTS` に追加してください（カンマ区切り、`*.` で始まるとサブドメインに一致）。この変数を設定すると既定の `*.ts.net` は置き換えられるため、Tailscale Serve を使う場合は併記してください：

```bash
PI_WEB_ALLOWED_HOSTS='pi.example.com,*.ts.net' pi-web --hostname 0.0.0.0
```

許可されていないホストへのリクエストは `421 unrecognized Host header; set PI_WEB_ALLOWED_HOSTS to allow it` で拒否されます。新しいアドレスでページが開かない場合は、まずこれを確認してください。

## HTTP プロキシ

TianForge pi は、サーバー側のモデルリクエストと API リクエストに標準の `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 環境変数を使用します。

macOS または Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 機能

- **作業をすぐに再開**：セッションのパスやターミナル履歴を探さずに、プロジェクトごとに過去の pi の会話を閲覧できます。
- **複数プロジェクトを並行処理**：プロジェクトごとにセッション、ファイルタブ、Agent の状態を保持し、切り替えてもバックグラウンドタスクは継続します。
- **長い会話を高速に切り替え**：最近の会話をブラウザにキャッシュし、古いメッセージはページ単位で読み込みます。
- **別の方向性を安全に試す**：以前のメッセージから続けるか、セッションをフォークして別の進め方を試せます。
- **ブランチをまたいで作業**：サイドバーから Git worktree を切り替えると、新しいセッションと Explorer が選択したチェックアウトに追従します。
- **プロジェクトを見ながらチャット**：エージェントの作業中に、左側でファイルを閲覧し、右側でソース、ドキュメント、画像、音声、PDF をプレビューできます。
- **セッションの状態を明確に把握**：コンテキスト使用量、コスト、コンパクション状態、システムプロンプトの詳細をトップバーで確認できます。
- **ターミナルでの設定を削減**：モデル、ログイン／API キー、モデルテスト、スキルの切り替えを Web UI から管理できます。

## 注意事項

- **データディレクトリ**：TianForge pi はデフォルトで `~/.pi/agent/sessions` を読み込みます。別の pi エージェントディレクトリを指定するには `PI_CODING_AGENT_DIR` を設定してください。
- **セッションファイル**：ファイルは `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` に保存されます。
- **モデル設定**：Models パネルは pi エージェントディレクトリ内の `models.json` を読み書きします。モデルの一覧とデフォルト値は pi の設定から取得されます。
- **Bash ウォッチドッグ**：モデルが開始した Bash 呼び出しには既定で 300 秒のタイムアウトが付き、停止した子プロセスがセッションと steer キューを永久に塞ぐのを防ぎます。`TIANFORGE_BASH_TIMEOUT_SECONDS` で別の正数を指定でき、`0` で pi の無制限待機に戻せます。モデルが明示したタイムアウトが優先されます。
- **ファイルアクセス**：ファイルの閲覧とプレビューは、選択したプロジェクトディレクトリとセッションに含まれる作業ディレクトリに限定されます。
- **Git worktree**：切り替え機能が表示される条件、新しい worktree の作成方法、削除時の動作については、[TianForge pi の Worktree](./docs/worktrees.md) を参照してください。
- **Fork とセッション内ブランチの違い**：Fork は新しい `.jsonl` ファイルを作成します。"Edit from here" は同じセッションファイル内に別のブランチを作成します。
- **同期について**：TianForge pi とターミナルの `pi` は同じセッションファイルを共有します。バックグラウンド更新、キャッシュ、ページング、同時書き込みの制約については [Staying in Sync](./docs/sync.md) を参照してください。

## 開発

```bash
npm install
npm run dev
```

既定の開発サーバーは HTTP の [http://127.0.0.1:30141](http://127.0.0.1:30141) で起動し、ローカルホストからのみアクセスできます。パスワード、証明書、`mkcert` は不要です。LAN 内の別デバイスから HTTPS でテストする場合は、`npm run dev:https` を明示的に実行してください。

Tailscale 経由で継続的に利用する場合は、ローカルの `mkcert` 証明書ではなくブラウザが信頼する `*.ts.net` 証明書を使える Tailscale Serve を推奨します。`npm run dev:https` を起動したまま、次を一度だけ設定します。

```bash
tailscale serve --bg https+insecure://127.0.0.1:30141
tailscale serve status
```

以後は `serve status` に表示される `https://<device>.<tailnet>.ts.net/` を開きます。`--bg` の設定は Tailscale や Mac の再起動後も保持され、TianForge サーバーだけを起動すれば利用できます。開発モードでは二階層の tailnet ホスト名を通した Next.js HMR WebSocket のために `**.ts.net` を許可しています。`https://100.x.y.z:30141` への直接アクセスでは引き続き `mkcert` のルート CA をスマートフォン側で信頼する必要があります。

モバイルでは PWA のインストール案内を常に表示します。Android は利用可能な場合にブラウザのインストール操作を表示し、iOS は「共有 → ホーム画面に追加」を案内します。Fullscreen API に対応するブラウザでは、別途ワンタップの全画面ボタンも表示します。インストールした TianForge のアイコンから起動するとアドレスバーは表示されません。

開発モードでは、数日間の連続稼働と多数のホットリロードで Node のヒープを使い切らないよう、Turbopack のメモリ目標を既定で 1536 MB に制限します。調整する場合は起動前に `PI_WEB_TURBOPACK_MEMORY_MB`（最小 512）を設定してください（例: `PI_WEB_TURBOPACK_MEMORY_MB=2048 npm run dev`）。変更後は開発サーバーの再起動が必要です。

よく使うチェック：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

ローカル開発中は `next build` / `npm run build` を実行しないでください。`.next/` に書き込みが行われ、開発サーバーに影響する可能性があります。ビルドはリリース作業に任せてください。

## プロジェクト構成

```text
app/
  api/
    agent/          # AgentSession を作成・操作し、SSE イベントを公開
    auth/           # OAuth と API キーの管理
    cwd/validate/   # カスタム作業ディレクトリの検証
    default-cwd/    # pi のデフォルト作業ディレクトリを取得
    files/          # ファイルの一覧、読み込み、プレビュー、監視
    home/           # 現在のユーザーのホームディレクトリ
    models/         # 利用可能なモデル、デフォルトモデル、思考レベル
    models-config/  # models.json の読み書きとモデルのテスト
    sessions/       # セッションの読み込み、名前変更、削除、コンテキスト、HTML エクスポート
    skills/         # スキルの一覧、検索、インストール、有効化／無効化
components/
  AppShell.tsx        # メインレイアウト、URL 状態、上部パネル、ファイルタブ
  SessionSidebar.tsx  # プロジェクト選択、セッションツリー、Explorer
  ChatWindow.tsx      # メッセージ、SSE、画像のドラッグ＆ドロップ、ミニマップ
  ChatInput.tsx       # 入力欄、モデル／ツール／思考／コンパクション／スラッシュコントロール
  MessageView.tsx     # メッセージ、思考、ツール呼び出し／結果の表示
  ModelsConfig.tsx    # モデルと認証の設定パネル
  SkillsConfig.tsx    # スキル管理パネル
  FileExplorer.tsx    # ファイルツリー
  FileViewer.tsx      # ソース、差分、画像、音声、PDF、DOCX のプレビュー
lib/
  http-dispatcher.ts  # サーバー側 fetch の HTTP(S) プロキシ設定
  rpc-manager.ts      # AgentSessionWrapper のライフサイクルとグローバルレジストリ
  session-reader.ts   # .jsonl セッションファイルとブランチコンテキストの解析
  normalize.ts        # toolCall フィールド名の正規化
  file-access.ts      # ファイル読み込みの安全境界
  file-paths.ts       # ファイルパスのエンコードと相対パスのヘルパー
  markdown.ts         # Markdown／Mermaid／KaTeX プラグインの設定
  pi-types.ts         # pi 関連の型
hooks/
  useAgentSession.ts  # セッションの読み込み、コマンド送信、SSE ステートマシン
  useAudio.ts         # 完了通知音
  useDragDrop.ts      # 画像のドラッグ＆ドロップ
  useTheme.ts         # テーマの切り替え
bin/
  pi-web.js           # npm CLI エントリポイント
instrumentation.ts    # サーバー HTTP ディスパッチャーの初期化
```
