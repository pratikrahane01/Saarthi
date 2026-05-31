import * as vscode from 'vscode';
import { activateWatcher } from './watcher';

export function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    activateWatcher(context);

    let disposable = vscode.commands.registerCommand('zeroMagic.triggerSocraticHelp', () => {
        vscode.window.showInformationMessage('Help me think (Zero-Magic)!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
