import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    let disposable = vscode.commands.registerCommand('zero-magic.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Zero-Magic!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
