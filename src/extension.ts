import * as vscode from 'vscode';
import { activateWatcher } from './watcher';

export function activate(context: vscode.ExtensionContext) {
    activateWatcher(context);
}
