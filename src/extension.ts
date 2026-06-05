import * as vscode from 'vscode';
import { activateWatcher } from './watcher';
import { SocraticDashboardPanel } from './ui/dashboard';
import { Mission } from './missions';

export function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    activateWatcher(context);

    let renderDashboardCmd = vscode.commands.registerCommand('zeroMagic.renderSocraticDashboard', (mission: Mission) => {
        SocraticDashboardPanel.createOrShow(mission);
    });

    context.subscriptions.push(renderDashboardCmd);
}

export function deactivate() {}
