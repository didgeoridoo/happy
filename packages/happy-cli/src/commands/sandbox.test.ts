import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import {
    detectWorkspaceRootSuggestions,
    handleSandboxCommand,
    handleSandboxDisable,
    handleSandboxStatus,
    handleSandboxConfigure,
    manageList,
} from './sandbox';

const { mockPrompt, mockReadSettings, mockUpdateSettings } = vi.hoisted(() => ({
    mockPrompt: vi.fn(),
    mockReadSettings: vi.fn(),
    mockUpdateSettings: vi.fn(),
}));

vi.mock('inquirer', () => ({
    default: {
        prompt: mockPrompt,
        Separator: class Separator {
            type = 'separator';
            line: string;
            constructor(line = '') { this.line = line; }
        },
    },
}));

vi.mock('@/persistence', async () => {
    const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
    return {
        ...actual,
        readSettings: mockReadSettings,
        updateSettings: mockUpdateSettings,
    };
});

const fullConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/Projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('handleSandboxCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes configure subcommand', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        // Main menu → cancel
        mockPrompt.mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxCommand(['configure']);

        expect(mockPrompt).toHaveBeenCalled();
    });

    it('routes status subcommand', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxCommand(['status']);

        expect(mockReadSettings).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('Sandbox is not configured. Run `happy sandbox configure`.');
    });

    it('routes disable subcommand', async () => {
        mockUpdateSettings.mockImplementation(async (updater: (value: any) => any) => {
            return updater({
                sandboxConfig: fullConfig,
            });
        });

        await handleSandboxCommand(['disable']);

        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    });
});

describe('handleSandboxConfigure', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('loads existing config and can cancel', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: fullConfig });
        mockPrompt.mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxConfigure();

        expect(mockReadSettings).toHaveBeenCalledTimes(1);
        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('saves config when save & enable is selected', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        mockUpdateSettings.mockResolvedValue(undefined);

        // Main menu → save, then confirm
        mockPrompt
            .mockResolvedValueOnce({ action: 'save' })
            .mockResolvedValueOnce({ confirmSave: true });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
        const updater = mockUpdateSettings.mock.calls[0][0];
        const result = updater({ sandboxConfig: undefined });
        expect(result.sandboxConfig.enabled).toBe(true);
    });

    it('returns to menu when save is not confirmed', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });

        // Save → decline → cancel
        mockPrompt
            .mockResolvedValueOnce({ action: 'save' })
            .mockResolvedValueOnce({ confirmSave: false })
            .mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('navigates to scope menu and back', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: fullConfig });

        // Main → scope → pick strict → main → cancel
        mockPrompt
            .mockResolvedValueOnce({ action: 'scope' })
            .mockResolvedValueOnce({ isolation: 'strict' })
            .mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('navigates to network menu with custom mode', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: fullConfig });

        // Main → network → custom → back from domains → confirm localhost → main → cancel
        mockPrompt
            .mockResolvedValueOnce({ action: 'network' })
            .mockResolvedValueOnce({ mode: 'custom' })
            .mockResolvedValueOnce({ action: 'back' }) // domain sub-menu → back
            .mockResolvedValueOnce({ allowLocal: true })
            .mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('navigates to filesystem menu and back', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: fullConfig });

        // Main → filesystem → back → cancel
        mockPrompt
            .mockResolvedValueOnce({ action: 'filesystem' })
            .mockResolvedValueOnce({ action: 'back' })
            .mockResolvedValueOnce({ action: 'cancel' });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('disable from menu disables sandbox', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: fullConfig });
        mockUpdateSettings.mockResolvedValue(undefined);

        mockPrompt.mockResolvedValueOnce({ action: 'disable' });

        await handleSandboxConfigure();

        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
        const updater = mockUpdateSettings.mock.calls[0][0];
        const result = updater({ sandboxConfig: fullConfig });
        expect(result.sandboxConfig.enabled).toBe(false);
    });
});

describe('manageList', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('returns current items when back is selected', async () => {
        mockPrompt.mockResolvedValueOnce({ action: 'back' });

        const result = await manageList('Test', ['a', 'b'], []);

        expect(result).toEqual(['a', 'b']);
    });

    it('adds an item', async () => {
        mockPrompt
            .mockResolvedValueOnce({ action: 'add' })
            .mockResolvedValueOnce({ value: 'new-item' })
            .mockResolvedValueOnce({ action: 'back' });

        const result = await manageList('Test', ['existing'], []);

        expect(result).toEqual(['existing', 'new-item']);
    });

    it('removes items', async () => {
        mockPrompt
            .mockResolvedValueOnce({ action: 'remove' })
            .mockResolvedValueOnce({ toRemove: ['b'] })
            .mockResolvedValueOnce({ action: 'back' });

        const result = await manageList('Test', ['a', 'b', 'c'], []);

        expect(result).toEqual(['a', 'c']);
    });

    it('resets to defaults', async () => {
        mockPrompt
            .mockResolvedValueOnce({ action: 'reset' })
            .mockResolvedValueOnce({ action: 'back' });

        const result = await manageList('Test', ['custom'], ['default1', 'default2']);

        expect(result).toEqual(['default1', 'default2']);
    });
});

describe('handleSandboxStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('prints not configured when sandbox is missing', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxStatus();

        expect(logSpy).toHaveBeenCalledWith('Sandbox is not configured. Run `happy sandbox configure`.');
    });

    it('prints all sandbox fields when present', async () => {
        const config: SandboxConfig = {
            ...fullConfig,
            networkMode: 'custom',
            allowedDomains: ['api.anthropic.com'],
            deniedDomains: ['evil.com'],
        };

        mockReadSettings.mockResolvedValue({ sandboxConfig: config });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxStatus();

        const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(allOutput).toContain('Sandbox status');
        expect(allOutput).toContain('yes');
        expect(allOutput).toContain('workspace');
        expect(allOutput).toContain('custom');
        expect(allOutput).toContain('api.anthropic.com');
        expect(allOutput).toContain('evil.com');
        expect(allOutput).toContain('~/.ssh');
        expect(allOutput).toContain('.env');
        expect(allOutput).toContain('/tmp');
    });

    it('shows strict scope correctly', async () => {
        const config: SandboxConfig = {
            ...fullConfig,
            sessionIsolation: 'strict',
        };

        mockReadSettings.mockResolvedValue({ sandboxConfig: config });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxStatus();

        const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
        expect(allOutput).toContain('per-project');
    });
});

describe('handleSandboxDisable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sets sandboxConfig.enabled to false', async () => {
        const current = { sandboxConfig: fullConfig };

        let updated: any;
        mockUpdateSettings.mockImplementation(async (updater: (value: any) => any) => {
            updated = updater(current);
            return updated;
        });

        await handleSandboxDisable();

        expect(updated.sandboxConfig.enabled).toBe(false);
    });
});

describe('detectWorkspaceRootSuggestions', () => {
    it('returns existing roots in platform order', () => {
        const suggestions = detectWorkspaceRootSuggestions({
            platform: 'darwin',
            home: '/Users/test',
            pathExists: (path) => path === '/Users/test/Develop' || path === '/Users/test/Workspace',
        });

        expect(suggestions).toEqual(['~/Develop', '~/Workspace']);
    });

    it('returns first platform default when none exist', () => {
        const suggestions = detectWorkspaceRootSuggestions({
            platform: 'linux',
            home: '/home/test',
            pathExists: () => false,
        });

        expect(suggestions).toEqual(['~/Workspace']);
    });
});
