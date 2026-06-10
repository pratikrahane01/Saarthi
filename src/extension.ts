import * as vscode from 'vscode';
import { activateWatcher } from './watcher';
import { SocraticSidebarProvider } from './ui/sidebar';
import { Mission } from './missions';
import { cleanUpAllTests } from './interceptor';
import { ContextBuilder } from './contextBuilder';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Zero-Magic Deconstruction Agent is now active.');

    // Phase 9: Clean up any orphaned test files from previous sessions
    await cleanUpAllTests();

    // Terminal-aware context: start buffering terminal output + exit codes
    // so every subsequent Quick Fix trigger has runtime context available.
    ContextBuilder.instance.activate();

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

    // Primary UI command — sidebar.ts is the single source of truth for all
    // mission state (IDLE → QUESTIONING → HINTING → PASSED / FAILED).
    // The legacy floating dashboard panel has been retired as primary UI.
    const renderDashboardCmd = vscode.commands.registerCommand(
        'zeroMagic.renderSocraticDashboard',
        (mission: Mission) => {
            if (SocraticSidebarProvider.instance) {
                SocraticSidebarProvider.instance.showMission(mission);
            }
        }
    );

    context.subscriptions.push(renderDashboardCmd);
}


export async function deactivate() {
    await cleanUpAllTests();
    ContextBuilder.instance.dispose();
}
