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
      }
    ]
    ```

## 🏃‍♂️ 執行應用

1.  在專案根目錄下執行以下命令來啟動 Web 伺服器：
    ```bash
    node index.js
    ```

2.  伺服器啟動後，會顯示監聽的網址。打開您的瀏覽器並前往：
    `http://localhost:3000`

3.  **登入**: 使用您在 `users.json` 中設定的使用者名稱和密碼進行登入。預設為 `admin` / `password`。

4.  **連線**: 登入後，點擊 `+` 按鈕，從彈出視窗中選擇您要連線的主機，開始使用！