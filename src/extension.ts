import * as vscode from 'vscode';
import { activateWatcher } from './watcher';
import { SocraticDashboardPanel } from './ui/dashboard';
import { SocraticSidebarProvider } from './ui/sidebar';
import { Mission } from './missions';

export function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    // Phase 1: Activate the error watcher & Quick Fix provider
    activateWatcher(context);

    // Phase 5: Register the Socratic Sidebar in the Activity Bar
    const sidebarProvider = new SocraticSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SocraticSidebarProvider.viewType,
            sidebarProvider
        )
    );

    // Dashboard command — push mission to BOTH the old panel and the new sidebar
    let renderDashboardCmd = vscode.commands.registerCommand('zeroMagic.renderSocraticDashboard', (mission: Mission) => {
        // Show in the legacy floating panel (Teammate 1 Phase 6 work)
        SocraticDashboardPanel.createOrShow(mission);

        // Also push to the new sidebar (Teammate 4 Phase 5 work)
        if (SocraticSidebarProvider.instance) {
            SocraticSidebarProvider.instance.showMission(mission);
        }
    });

    context.subscriptions.push(renderDashboardCmd);
}

export function deactivate() {}
