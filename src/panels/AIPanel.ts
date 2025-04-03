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
        }
      },
      null,
      this._disposables
    );
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
      }
    );

    AIPanel.currentPanel = new AIPanel(panel, extensionUri);
    AIPanel._outputChannel.appendLine("AI panel created and initialized");
    return AIPanel.currentPanel;
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
