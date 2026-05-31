import * as vscode from 'vscode';
import { activateWatcher } from './watcher';

export function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    activateWatcher(context);
}

export function deactivate() {}
