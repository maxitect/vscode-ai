/**
 * The main panel for the Assistant extension.
 * It manages:
 * - Creating and displaying the main assistant webview panel
 * - Handling communication between VS Code extension and webview
 * - Processing API requests to OpenAI
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as config from "../config";
import axios from "axios";

export class AIPanel {
  public static currentPanel: AIPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private static readonly _outputChannel =
    vscode.window.createOutputChannel("AI Assistant");
  private _conversation: Array<{ role: string; content: string }> = [];

  private readonly _extensionPath: string;

  private get _apiKey(): string {
    return config.getApiKey();
  }

  private get _model(): string {
    return config.getModel();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionPath = extensionUri.fsPath;
    AIPanel._outputChannel.appendLine("Initializing AI Assistant panel...");

    this._setupWebview(extensionUri);
    this._registerMessageListener();
  }

  private _setupWebview(extensionUri: vscode.Uri): void {
    if (!this._panel.webview) {
      throw new Error("Webview is not available");
    }

    this._panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri],
    };

    this._panel.webview.html = this._getWebviewContent();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _registerMessageListener(): void {
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "askQuestion":
            await this._handleUserMessage(message.text);
            break;
          case "clearConversation":
            this._conversation = [];
            this._sendMessageToWebview({
              type: "clear",
            });
            break;
          case "attachCode":
            await this._handleAttachCode();
            break;
          case "removeFile":
            this._handleRemoveFile(message.fileName);
            break;
          case "clearContext":
            this._handleClearContext();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  private _handleRemoveFile(fileName: string): void {
    // Remove the file from conversation context
    this._conversation = this._conversation.filter((msg) => {
      // Only filter out system messages that contain this file
      if (
        msg.role === "system" &&
        msg.content.includes(`Code attachment - ${fileName}:`)
      ) {
        return false;
      }
      return true;
    });

    AIPanel._outputChannel.appendLine(`Removed file from context: ${fileName}`);
  }

  private async _handleAttachCode(): Promise<void> {
    try {
      const codeContent = await this._getActiveEditorContent();
      if (codeContent) {
        // Regardless of whether there's a user message, add the code to context
        // Rather than attaching to a specific message
        const attachmentMsg = `File added to context: ${codeContent.fileName}`;

        // Add the code to a system message in the conversation
        this._conversation.push({
          role: "system",
          content: `Code attachment - ${codeContent.fileName}:\n\`\`\`\n${codeContent.text}\n\`\`\``,
        });

        // Inform the webview about the code attachment
        this._sendMessageToWebview({
          type: "codeAttached",
          fileName: codeContent.fileName,
          content: attachmentMsg,
        });
      } else {
        this._sendMessageToWebview({
          type: "error",
          content: "No code to attach",
        });
      }
    } catch (error) {
      const errorMessage = `Error attaching code: ${error}`;
      AIPanel._outputChannel.appendLine(errorMessage);

      this._sendMessageToWebview({
        type: "error",
        content: errorMessage,
      });
    }
  }

  private _findLastUserMessage():
    | { role: string; content: string }
    | undefined {
    for (let i = this._conversation.length - 1; i >= 0; i--) {
      if (this._conversation[i].role === "user") {
        return this._conversation[i];
      }
    }
    return undefined;
  }

  private async _handleUserMessage(text: string): Promise<void> {
    try {
      this._conversation.push({ role: "user", content: text });

      const response = await this._callOpenAI();

      if (response) {
        this._conversation.push({ role: "assistant", content: response });

        this._sendMessageToWebview({
          type: "response",
          content: response,
        });
      }
    } catch (error) {
      const errorMessage = `Error processing message: ${error}`;
      AIPanel._outputChannel.appendLine(errorMessage);

      this._sendMessageToWebview({
        type: "error",
        content: errorMessage,
      });
    }
  }

  private _handleClearContext(): void {
    // Keep only non-system messages
    this._conversation = this._conversation.filter(
      (msg) => msg.role !== "system"
    );

    this._sendMessageToWebview({
      type: "contextCleared",
    });

    AIPanel._outputChannel.appendLine("Cleared all files from context");
  }

  private async _callOpenAI(): Promise<string> {
    const apiKey = this._apiKey;

    if (!apiKey) {
      throw new Error(
        "API key not found. Please set it in the extension settings or .env file."
      );
    }

    try {
      AIPanel._outputChannel.appendLine(
        `Calling OpenAI API with model: ${this._model}`
      );

      const response = await axios.post(
        config.OPENAI_API_ENDPOINT,
        {
          model: this._model,
          messages: this._conversation,
          max_tokens: config.MAX_TOKENS,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      if (
        response.data &&
        response.data.choices &&
        response.data.choices.length > 0
      ) {
        return response.data.choices[0].message.content;
      } else {
        throw new Error("Invalid response from OpenAI API");
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        AIPanel._outputChannel.appendLine(
          `API Error: ${JSON.stringify(error.response?.data || error.message)}`
        );
        throw new Error(
          `API Error: ${error.response?.data?.error?.message || error.message}`
        );
      } else {
        AIPanel._outputChannel.appendLine(`Error: ${error}`);
        throw error;
      }
    }
  }

  private _sendMessageToWebview(message: any): void {
    this._panel.webview.postMessage(message);
  }

  public static async createOrShow(extensionUri: vscode.Uri): Promise<AIPanel> {
    AIPanel._outputChannel.appendLine("Creating or showing AI panel...");

    const panel = vscode.window.createWebviewPanel(
      "aiAssistantPanel",
      "AI Assistant",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    AIPanel.currentPanel = new AIPanel(panel, extensionUri);
    AIPanel._outputChannel.appendLine("AI panel created and initialized");
    return AIPanel.currentPanel;
  }

  private async _getActiveEditorContent(): Promise<{
    text: string;
    fileName: string;
    fileType: string;
  } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return await this._promptUserForFile();
    }

    const document = editor.document;
    const fileName = path.basename(document.fileName);
    const text = document.getText();
    const fileType = this._getFileType(document.fileName);

    if (!text.trim()) {
      return null;
    }

    return { text, fileName, fileType };
  }

  private async _promptUserForFile(): Promise<{
    text: string;
    fileName: string;
    fileType: string;
  } | null> {
    try {
      // Get all text files in the workspace
      const files = await vscode.workspace.findFiles(
        "**/*.{js,ts,jsx,tsx,py,html,css,json,md}",
        "**/node_modules/**"
      );

      if (files.length === 0) {
        return null;
      }

      // Convert to relative paths for easier selection
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : "";

      const fileItems = files.map((file) => {
        const relativePath = rootPath
          ? path.relative(rootPath, file.fsPath)
          : file.fsPath;
        return {
          label: relativePath,
          description: "",
          detail: file.fsPath,
          fullPath: file.fsPath,
        };
      });

      // Allow user to select a file
      const selectedFile = await vscode.window.showQuickPick(fileItems, {
        placeHolder: "Select a file to attach",
        ignoreFocusOut: true,
      });

      if (!selectedFile) {
        return null;
      }

      try {
        // Read the selected file
        const fileContent = await fs.promises.readFile(
          selectedFile.fullPath,
          "utf8"
        );
        const fileName = path.basename(selectedFile.fullPath);
        const fileType = this._getFileType(selectedFile.fullPath);

        return { text: fileContent, fileName, fileType };
      } catch (error) {
        AIPanel._outputChannel.appendLine(`Error reading file: ${error}`);
        throw new Error(`Failed to read file: ${error}`);
      }
    } catch (error) {
      AIPanel._outputChannel.appendLine(`Error selecting file: ${error}`);
      throw new Error(`Failed to select file: ${error}`);
    }
  }

  private _getFileType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();

    const fileTypeMap: { [key: string]: string } = {
      ".js": "javascript",
      ".ts": "typescript",
      ".jsx": "javascript",
      ".tsx": "typescript",
      ".py": "python",
      ".html": "html",
      ".css": "css",
      ".json": "json",
      ".md": "markdown",
      ".c": "c",
      ".cpp": "cpp",
      ".h": "c",
      ".java": "java",
      ".go": "go",
      ".rb": "ruby",
      ".php": "php",
      ".sh": "bash",
      ".rs": "rust",
      ".swift": "swift",
      ".sql": "sql",
      ".yml": "yaml",
      ".yaml": "yaml",
      ".xml": "xml",
      ".cs": "csharp",
      ".kt": "kotlin",
      ".dart": "dart",
      ".r": "r",
    };

    return fileTypeMap[extension] || "plaintext";
  }

  private _getWebviewContent(): string {
    try {
      const htmlPath = path.join(
        this._extensionPath,
        "out",
        "webview",
        "webview.html"
      );

      if (!fs.existsSync(htmlPath)) {
        throw new Error(`HTML file not found at: ${htmlPath}`);
      }

      return fs.readFileSync(htmlPath, "utf8");
    } catch (error) {
      const errorMessage = `Error loading webview content: ${error}`;
      AIPanel._outputChannel.appendLine(errorMessage);
      return `<html><body><h1>Error loading content</h1><p>${errorMessage}</p></body></html>`;
    }
  }

  public dispose(): void {
    AIPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
