import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
    SandboxConfigSchema,
    readSettings,
    updateSettings,
    type SandboxConfig,
} from '@/persistence';

const DEFAULT_WORKSPACE_ROOT = '~/Workspace';
const SCHEMA_DEFAULTS = SandboxConfigSchema.parse({});

type ScopeMode = 'workspace' | 'project';

function workspaceCandidatesForPlatform(platform: NodeJS.Platform): string[] {
    if (platform === 'darwin') {
        return ['~/Developer', '~/Develop', '~/Workspace', '~/Projects'];
    }
    if (platform === 'linux') {
        return ['~/Workspace', '~/Developer', '~/Develop', '~/Projects'];
    }
    return ['~/Developer', '~/Develop', '~/Workspace', '~/Projects'];
}

export function detectWorkspaceRootSuggestions(options?: {
    platform?: NodeJS.Platform;
    home?: string;
    pathExists?: (path: string) => boolean;
}): string[] {
    const platform = options?.platform ?? process.platform;
    const home = options?.home ?? homedir();
    const pathExists = options?.pathExists ?? existsSync;
    const candidates = workspaceCandidatesForPlatform(platform);
    const existing = candidates.filter((candidate) => {
        const absolutePath = candidate.replace(/^~(?=\/|$)/, home);
        return pathExists(absolutePath);
    });
    if (existing.length > 0) {
        return existing;
    }

    return [candidates[0] ?? DEFAULT_WORKSPACE_ROOT];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatList(items: string[], fallback = '(none)'): string {
    return items.length > 0 ? items.join(', ') : chalk.dim(fallback);
}

function printConfigSummary(config: SandboxConfig): void {
    const scopeLabel = (() => {
        switch (config.sessionIsolation) {
            case 'strict': return 'per-project (CWD only)';
            case 'workspace': return `workspace (${config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT})`;
            case 'custom': return `custom (${config.customWritePaths.length} paths)`;
        }
    })();

    const networkLabel = (() => {
        switch (config.networkMode) {
            case 'allowed': return 'allowed (all)';
            case 'blocked': return 'blocked (none)';
            case 'custom':
                return `custom (${config.allowedDomains.length} allowed, ${config.deniedDomains.length} denied)`;
        }
    })();

    console.log('');
    console.log(chalk.bold('  Sandbox Configuration'));
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(`  Scope:        ${scopeLabel}`);
    console.log(`  Network:      ${networkLabel}`);
    console.log(`  Localhost:    ${config.allowLocalBinding ? 'yes' : 'no'}`);
    console.log(`  Deny reads:   ${formatList(config.denyReadPaths)}`);
    console.log(`  Deny writes:  ${formatList(config.denyWritePaths)}`);
    console.log(`  Extra writes: ${formatList(config.extraWritePaths)}`);
    if (config.sessionIsolation === 'custom') {
        console.log(`  Custom writes: ${formatList(config.customWritePaths)}`);
    }
    if (config.networkMode === 'custom') {
        console.log(`  Allowed domains: ${formatList(config.allowedDomains)}`);
        console.log(`  Denied domains:  ${formatList(config.deniedDomains)}`);
    }
    console.log('');
}

/**
 * Interactive list manager for string arrays (paths, domains, etc.)
 * Returns the updated array. Does not persist — caller is responsible for that.
 */
export async function manageList(
    label: string,
    current: string[],
    defaults: string[],
    validate?: (input: string) => true | string,
): Promise<string[]> {
    const items = [...current];

    while (true) {
        console.log(`\n  ${chalk.bold(label)}: ${formatList(items)}\n`);

        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: `Manage ${label.toLowerCase()}`,
            choices: [
                { name: 'Add item', value: 'add' },
                ...(items.length > 0
                    ? [{ name: 'Remove item(s)', value: 'remove' }]
                    : []),
                { name: `Reset to defaults (${defaults.length > 0 ? defaults.join(', ') : 'empty'})`, value: 'reset' },
                new inquirer.Separator(),
                { name: 'Back', value: 'back' },
            ],
        }]);

        if (action === 'back') {
            return items;
        }

        if (action === 'add') {
            const { value } = await inquirer.prompt([{
                type: 'input',
                name: 'value',
                message: `Enter ${label.toLowerCase().replace(/s$/, '')}:`,
                validate: (input: string) => {
                    if (!input.trim()) return 'Cannot be empty';
                    if (items.includes(input.trim())) return 'Already in list';
                    return validate ? validate(input.trim()) : true;
                },
            }]);
            items.push(value.trim());
        }

        if (action === 'remove' && items.length > 0) {
            const { toRemove } = await inquirer.prompt([{
                type: 'checkbox',
                name: 'toRemove',
                message: 'Select items to remove:',
                choices: items.map((item) => ({ name: item, value: item })),
            }]);
            for (const item of toRemove) {
                const idx = items.indexOf(item);
                if (idx !== -1) items.splice(idx, 1);
            }
        }

        if (action === 'reset') {
            items.length = 0;
            items.push(...defaults);
        }
    }
}

function validateDomain(input: string): true | string {
    if (input.startsWith('http://') || input.startsWith('https://')) {
        return 'Enter domain only, without protocol (e.g. api.example.com)';
    }
    if (input.includes('/')) {
        return 'Enter domain only, without path (e.g. api.example.com)';
    }
    if (!input.includes('.') && input !== 'localhost') {
        return 'Doesn\'t look like a valid domain';
    }
    return true;
}

// ── Sub-menus ────────────────────────────────────────────────────────────────

async function configureScopeMenu(config: SandboxConfig): Promise<void> {
    const workspaceRootSuggestions = detectWorkspaceRootSuggestions();
    const workspaceRootDefault = workspaceRootSuggestions[0] ?? DEFAULT_WORKSPACE_ROOT;

    const { isolation } = await inquirer.prompt([{
        type: 'list',
        name: 'isolation',
        message: 'How should file write access be scoped?',
        default: config.sessionIsolation,
        choices: [
            { name: 'strict    - Only current project directory (CWD)', value: 'strict' },
            { name: 'workspace - Full workspace root directory', value: 'workspace' },
            { name: 'custom    - Explicit list of writable paths', value: 'custom' },
        ],
    }]);

    config.sessionIsolation = isolation;

    if (isolation === 'workspace') {
        const choices = workspaceRootSuggestions.map((pathValue) => ({
            name: `${pathValue}${existsSync(pathValue.replace(/^~(?=\/|$)/, homedir())) ? '' : ' (suggested)'}`,
            value: pathValue,
        }));
        // Add current value if it's not in the suggestions
        if (config.workspaceRoot && !workspaceRootSuggestions.includes(config.workspaceRoot)) {
            choices.unshift({ name: `${config.workspaceRoot} (current)`, value: config.workspaceRoot });
        }
        choices.push({ name: 'Enter custom path...', value: '__custom__' });

        const { root } = await inquirer.prompt([{
            type: 'list',
            name: 'root',
            message: 'Workspace root directory:',
            default: config.workspaceRoot ?? workspaceRootDefault,
            choices,
        }]);

        if (root === '__custom__') {
            const { customRoot } = await inquirer.prompt([{
                type: 'input',
                name: 'customRoot',
                message: 'Enter workspace root path:',
                default: config.workspaceRoot ?? workspaceRootDefault,
                validate: (input: string) => input.trim() ? true : 'Cannot be empty',
            }]);
            config.workspaceRoot = customRoot.trim();
        } else {
            config.workspaceRoot = root;
        }
    }

    if (isolation === 'custom') {
        config.customWritePaths = await manageList(
            'Custom write paths',
            config.customWritePaths,
            SCHEMA_DEFAULTS.customWritePaths,
        );
    }
}

async function configureNetworkMenu(config: SandboxConfig): Promise<void> {
    const { mode } = await inquirer.prompt([{
        type: 'list',
        name: 'mode',
        message: 'How should network access be handled?',
        default: config.networkMode,
        choices: [
            { name: 'allowed - All network access permitted', value: 'allowed' },
            { name: 'blocked - No network access (most secure)', value: 'blocked' },
            { name: 'custom  - Allow/deny specific domains', value: 'custom' },
        ],
    }]);

    config.networkMode = mode;

    if (mode === 'custom') {
        while (true) {
            console.log(`\n  ${chalk.bold('Domain configuration')}`);
            console.log(`  Allowed: ${formatList(config.allowedDomains)}`);
            console.log(`  Denied:  ${formatList(config.deniedDomains)}\n`);

            const { action } = await inquirer.prompt([{
                type: 'list',
                name: 'action',
                message: 'Manage domains',
                choices: [
                    { name: 'Edit allowed domains', value: 'allowed' },
                    { name: 'Edit denied domains', value: 'denied' },
                    new inquirer.Separator(),
                    { name: 'Back', value: 'back' },
                ],
            }]);

            if (action === 'back') break;

            if (action === 'allowed') {
                config.allowedDomains = await manageList(
                    'Allowed domains',
                    config.allowedDomains,
                    SCHEMA_DEFAULTS.allowedDomains,
                    validateDomain,
                );
            }

            if (action === 'denied') {
                config.deniedDomains = await manageList(
                    'Denied domains',
                    config.deniedDomains,
                    SCHEMA_DEFAULTS.deniedDomains,
                    validateDomain,
                );
            }
        }
    }

    const { allowLocal } = await inquirer.prompt([{
        type: 'confirm',
        name: 'allowLocal',
        message: 'Allow binding to localhost ports? (for dev servers)',
        default: config.allowLocalBinding,
    }]);
    config.allowLocalBinding = allowLocal;
}

async function configureFilesystemMenu(config: SandboxConfig): Promise<void> {
    while (true) {
        console.log(`\n  ${chalk.bold('Filesystem paths')}`);
        console.log(`  Deny reads:   ${formatList(config.denyReadPaths)}`);
        console.log(`  Deny writes:  ${formatList(config.denyWritePaths)}`);
        console.log(`  Extra writes: ${formatList(config.extraWritePaths)}\n`);

        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'Which list to edit?',
            choices: [
                { name: `Deny read paths (${config.denyReadPaths.length})`, value: 'denyRead' },
                { name: `Deny write paths (${config.denyWritePaths.length})`, value: 'denyWrite' },
                { name: `Extra write paths (${config.extraWritePaths.length})`, value: 'extraWrite' },
                new inquirer.Separator(),
                { name: 'Back', value: 'back' },
            ],
        }]);

        if (action === 'back') break;

        if (action === 'denyRead') {
            config.denyReadPaths = await manageList(
                'Deny read paths',
                config.denyReadPaths,
                SCHEMA_DEFAULTS.denyReadPaths,
            );
        }

        if (action === 'denyWrite') {
            config.denyWritePaths = await manageList(
                'Deny write paths',
                config.denyWritePaths,
                SCHEMA_DEFAULTS.denyWritePaths,
            );
        }

        if (action === 'extraWrite') {
            config.extraWritePaths = await manageList(
                'Extra write paths',
                config.extraWritePaths,
                SCHEMA_DEFAULTS.extraWritePaths,
            );
        }
    }
}

// ── Main commands ────────────────────────────────────────────────────────────

export async function handleSandboxCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        handleSandboxHelp();
        return;
    }

    switch (subcommand) {
        case 'configure':
            await handleSandboxConfigure();
            break;
        case 'status':
            await handleSandboxStatus();
            break;
        case 'disable':
            await handleSandboxDisable();
            break;
        default:
            console.error(chalk.red(`Unknown sandbox subcommand: ${subcommand}`));
            handleSandboxHelp();
            process.exit(1);
    }
}

export async function handleSandboxConfigure(): Promise<void> {
    // Load existing config or start with schema defaults
    const settings = await readSettings();
    const config: SandboxConfig = settings.sandboxConfig
        ? { ...settings.sandboxConfig }
        : SandboxConfigSchema.parse({});

    while (true) {
        printConfigSummary(config);

        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'What to configure?',
            choices: [
                { name: 'Scope & isolation', value: 'scope' },
                { name: 'Network & domains', value: 'network' },
                { name: 'Filesystem paths', value: 'filesystem' },
                new inquirer.Separator(),
                { name: chalk.green('Save & enable'), value: 'save' },
                { name: chalk.yellow('Disable sandbox'), value: 'disable' },
                { name: 'Cancel', value: 'cancel' },
            ],
        }]);

        if (action === 'cancel') {
            console.log(chalk.yellow('Configuration cancelled.'));
            return;
        }

        if (action === 'disable') {
            await updateSettings((s) => ({
                ...s,
                sandboxConfig: SandboxConfigSchema.parse({
                    ...(s.sandboxConfig ?? {}),
                    enabled: false,
                }),
            }));
            console.log(chalk.green('Sandbox disabled.'));
            return;
        }

        if (action === 'save') {
            config.enabled = true;
            const validated = SandboxConfigSchema.parse(config);

            console.log(chalk.bold('\nFinal configuration:'));
            printConfigSummary(validated);

            const { confirmSave } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmSave',
                message: 'Save and enable this sandbox configuration?',
                default: true,
            }]);

            if (confirmSave) {
                await updateSettings((s) => ({
                    ...s,
                    sandboxConfig: validated,
                }));
                console.log(chalk.green('Sandbox configuration saved and enabled.'));
                console.log(chalk.gray('Use --no-sandbox to bypass sandboxing for a single session.'));
                return;
            }
            // If not confirmed, continue editing
            continue;
        }

        if (action === 'scope') {
            await configureScopeMenu(config);
        }

        if (action === 'network') {
            await configureNetworkMenu(config);
        }

        if (action === 'filesystem') {
            await configureFilesystemMenu(config);
        }
    }
}

export async function handleSandboxStatus(): Promise<void> {
    const settings = await readSettings();
    const config = settings.sandboxConfig;

    if (!config) {
        console.log('Sandbox is not configured. Run `happy sandbox configure`.');
        return;
    }

    console.log(chalk.bold('Sandbox status'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(`Enabled:          ${config.enabled ? chalk.green('yes') : chalk.red('no')}`);

    const scopeLabel = (() => {
        switch (config.sessionIsolation) {
            case 'strict': return 'per-project (strict)';
            case 'workspace': return 'workspace';
            case 'custom': return 'custom';
        }
    })();
    console.log(`Scope:            ${scopeLabel}`);
    if (config.sessionIsolation === 'workspace') {
        console.log(`Workspace root:   ${config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT}`);
    }
    if (config.sessionIsolation === 'custom' && config.customWritePaths.length > 0) {
        console.log(`Custom writes:    ${config.customWritePaths.join(', ')}`);
    }

    console.log(`Network mode:     ${config.networkMode}`);
    if (config.networkMode === 'custom') {
        console.log(`  Allowed domains: ${formatList(config.allowedDomains)}`);
        console.log(`  Denied domains:  ${formatList(config.deniedDomains)}`);
    }
    console.log(`Localhost:        ${config.allowLocalBinding ? 'yes' : 'no'}`);
    console.log(`Deny reads:       ${formatList(config.denyReadPaths)}`);
    console.log(`Deny writes:      ${formatList(config.denyWritePaths)}`);
    console.log(`Extra writes:     ${formatList(config.extraWritePaths)}`);
}

export async function handleSandboxDisable(): Promise<void> {
    await updateSettings((settings) => ({
        ...settings,
        sandboxConfig: SandboxConfigSchema.parse({
            ...(settings.sandboxConfig ?? {}),
            enabled: false,
        }),
    }));

    console.log(chalk.green('Sandbox disabled.'));
}

export function handleSandboxHelp(): void {
    console.log(`
${chalk.bold('happy sandbox')} - Sandbox management

${chalk.bold('Usage:')}
  happy sandbox configure      Configure sandbox settings interactively
  happy sandbox status         Show current sandbox configuration
  happy sandbox disable        Disable sandboxing
  happy sandbox help           Show this help
`);
}
