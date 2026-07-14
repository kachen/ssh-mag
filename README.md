# SSH-Mag - Your Personal Web-Based SSH Terminal

SSH-Mag 是一個基於 Node.js 和現代 Web 技術的 SSH 管理工具，它將您的瀏覽器變成一個強大的、可持續性的多頁籤 SSH 客戶端。

## ✨ 功能亮點

*   **使用者認證**: 透過使用者名稱和密碼登入，確保只有授權的使用者才能存取 SSH 終端。
*   **多頁籤介面**: 在單一瀏覽器視窗中，同時管理多個獨立的 SSH 連線。
*   **完整的狀態持續性**: 
    *   **畫面保持**: 重新整理頁面後，所有頁籤及其終端機畫面內容都會被完整恢復。
    *   **階段續連**: 關閉並重新打開瀏覽器後，所有工作階段都會被完整保留，無縫接續您上次的工作。
*   **網頁終端**: 基於 `xterm.js` 的全功能網頁終端，提供流暢、真實的互動體驗。
*   **線上配置中心**: 
    *   **主機管理**: 直接在網頁上新增、修改、刪除 `hosts.json` 中的主機設定。
    *   **快捷指令**: 在網頁上自訂 `shortcuts.json`，為每個終端機加上一鍵執行常用指令的按鈕。
*   **強大的指令模板**: 在快捷指令中，不僅可以引用當前主機的參數，更可以交叉引用 `hosts.json` 中任何其他主機的參數。
*   **特定主機指令**: 可設定快捷指令只在特定主機的連線中顯示。
*   **即時互動**: 使用 WebSocket 進行低延遲的即時雙向通訊。
*   **批量指令執行**: 支援同時對多台選定的主機執行 Shell 指令，並彙整顯示執行結果與狀態碼，方便進行群組管理與運維操作。
*   **AI Ops 助手**: 右側 Chat 面板，後端接 **`grok agent serve`**（ACP）。Agent 透過 **ssh-mag MCP** 開關 session、在 xterm 下指令、或 batch 執行。

---

## 🚀 設定與安裝

1.  **安裝 Node.js**: 確保您的系統上已安裝 Node.js (建議使用 LTS 版本)。

2.  **安裝依賴**: 在專案根目錄下執行以下命令來安裝所有必要的套件：
    ```bash
    npm install
    ```

3.  **設定使用者 (`users.json`)**:
    在專案根目錄建立 `users.json` 檔案。這是一個包含使用者物件的陣列，用於登入認證。
    
    **範例 `users.json`**:
    ```json
    [
      {
        "username": "admin",
        "password": "password"
      }
    ]
    ```

4.  **設定主機 (`hosts.json`)**: 
    在專案根目錄建立或編輯 `hosts.json` 檔案。這是一個**物件**，其**鍵 (key)** 是您希望顯示的主機名稱，**值 (value)** 是該主機的連線設定。

    **範例 `hosts.json`**:
    ```json
    {
      "My-VPS": {
        "host": "1.2.3.4",
        "username": "root",
        "password": "your_password"
      },
      "Work-Server": {
        "host": "work.example.com",
        "username": "devops",
        "privateKeyPath": "./keys/work_id_rsa"
      }
    }
    ```

5.  **設定快捷指令 (`shortcuts.json`)**: 
    (選用) 在專案根目錄建立或編輯 `shortcuts.json` 檔案。您可以在指令中使用模板，並可選擇性地將指令限定在特定主機上顯示。

    *   `name`: (必需) 按鈕上顯示的名稱。
    *   `command`: (必需) 要執行的指令，可使用模板。
    *   `for`: (選用) 一個包含主機名稱的陣列。如果設定了此欄位，該快捷指令只會在使用這些指定主機名稱連線時顯示。如果省略此欄位，則為通用指令，對所有主機顯示。

    **模板語法**:
    *   簡單引用 (當前主機): `{host}`, `{username}`, `{port}`
    *   交叉引用 (任何主機): `{主機名稱.參數名稱}`，例如 `{My-VPS.host}`

    **範例 `shortcuts.json`**:
    ```json
    [
      {
        "name": "Ping Self",
        "command": "ping -c 4 {host}"
      },
      {
        "name": "Show Docker (Work)",
        "command": "docker ps -a",
        "for": ["Work-Server"]
      },
      {
        "name": "SSH to My VPS",
        "command": "ssh {My-VPS.username}@{My-VPS.host}"
      },
      {
        "name": "Show Test Value",
        "command": "echo {some_server.test_val}" 
      }
    ]
    ```
    在上面的範例中，執行 "Show Test Value" 指令時，因為 `some_server` 不存在，系統會自動尋找並列出所有定義了 `test_val` 參數的主機讓您選擇。

## 🏃‍♂️ 執行應用

1.  在專案根目錄下執行以下命令來啟動 Web 伺服器：
    ```bash
    node index.js
    ```

2.  伺服器啟動後，會顯示監聽的網址。打開您的瀏覽器並前往：
    `http://localhost:3000`

3.  **登入**: 使用您在 `users.json` 中設定的使用者名稱和密碼進行登入。預設為 `admin` / `password`。

4.  **開始使用**: 登入後，點擊 `+` 按鈕開啟主選單。您可以：
    *   選擇主機進行 **SSH 連線**。
    *   使用 **Batch Run** 進行批量指令執行。
    *   使用 **Edit Hosts** 或 **Edit Shortcuts** 線上修改設定。
    *   使用右側 **AI Ops** 用自然語言管理主機（指令會寫入對應 xterm）。

### AI 助手設定（grok agent serve）

架構：

```
Browser Chat  →  SSH-Mag (ACP client)
                      │  WebSocket ACP
                      ▼
              grok agent serve :2419
                      │  MCP stdio
                      ▼
              mcp-ssh-mag.js  →  SSH-Mag HTTP tools  →  xterm sessions
```

1. **登入 Grok CLI**（agent 用 cached token）：
   ```bash
   grok
   # 或已登入可略過
   ```

2. **在 `.env` 設定同一組 secret**（已 gitignore）：
   ```bash
   GROK_AGENT_SECRET=pick-a-long-random-string
   GROK_AGENT_URL=ws://127.0.0.1:2419/ws
   # 可選：固定 MCP 服務 token
   # SSH_MAG_MCP_TOKEN=another-secret
   # SSH_MAG_PUBLIC_BASE=http://127.0.0.1:3000
   ```

3. **啟動 agent（另開一個終端）**：
   ```bash
   grok agent --always-approve serve --bind 127.0.0.1:2419 --secret pick-a-long-random-string
   ```
   印出的 WebSocket URL 形如：`ws://127.0.0.1:2419/ws?server-key=...`

4. **啟動 SSH-Mag**：
   ```bash
   node index.js
   ```

5. 瀏覽器登入後，右側狀態應為 `Grok agent · …`。

**MCP 工具（agent 透過 mcp-ssh-mag.js 呼叫）**

| 工具 | 作用 |
|------|------|
| `list_hosts` / `list_sessions` | 列出主機與作用中 session |
| `open_host_session` | 建立 SSH session，前端自動開 xterm tab |
| `run_in_session` | 把指令寫進互動 PTY（xterm 可見） |
| `batch_run` | 多機非互動 exec（結果回 Chat） |

危險指令（`rm -rf`、`reboot`、`mkfs` 等）會被 SSH-Mag 擋下。密碼/私鑰不會經 MCP 回傳。

**對話與 Grok agent 上下文同步**

| 層 | 機制 |
|----|------|
| 瀏覽器 | `localStorage` 存訊息 + `acpSessionId` |
| SSH-Mag | `.acp-session.json` 記住 agent session |
| 重連 | 優先 `session/resume` → `session/load`；失敗則 `session/new` 並把 UI 歷史塞回 prompt |
| Clear | 清空 localStorage 並 `POST /api/ai/reset` 開新 agent session |