import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so these are available inside vi.mock factories
const {
  mockShow,
  mockOn,
  mockIsFocused,
  mockIsDestroyed,
  mockRestore,
  mockWindowShow,
  mockWindowFocus,
  mockIsMinimized,
  mockGetAllWindows,
  mockIsSupported,
  mockConfigGet,
} = vi.hoisted(() => ({
  mockShow: vi.fn(),
  mockOn: vi.fn(),
  mockIsFocused: vi.fn().mockReturnValue(false),
  mockIsDestroyed: vi.fn().mockReturnValue(false),
  mockRestore: vi.fn(),
  mockWindowShow: vi.fn(),
  mockWindowFocus: vi.fn(),
  mockIsMinimized: vi.fn().mockReturnValue(false),
  mockGetAllWindows: vi.fn(),
  mockIsSupported: vi.fn().mockReturnValue(true),
  mockConfigGet: vi.fn().mockReturnValue(true),
}));

function makeWindow() {
  return {
    isFocused: mockIsFocused,
    isDestroyed: mockIsDestroyed,
    isMinimized: mockIsMinimized,
    restore: mockRestore,
    show: mockWindowShow,
    focus: mockWindowFocus,
  };
}

vi.mock('electron', () => {
  function NotificationMock(opts: unknown) {
    Object.assign(this, opts);
    (this as { show: typeof mockShow }).show = mockShow;
    (this as { on: typeof mockOn }).on = mockOn;
  }
  NotificationMock.isSupported = mockIsSupported;

  return {
    Notification: NotificationMock,
    BrowserWindow: {
      getAllWindows: mockGetAllWindows,
    },
  };
});

vi.mock('../src/main/config/config-store', () => ({
  configStore: {
    get: (key: string) => mockConfigGet(key),
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
}));

// Import after mocks
import {
  notifyPermissionRequest,
  notifyAgentComplete,
} from '../src/main/utils/native-notifications';

describe('native-notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigGet.mockReturnValue(true);
    mockIsFocused.mockReturnValue(false);
    mockIsSupported.mockReturnValue(true);
    mockIsDestroyed.mockReturnValue(false);
    mockIsMinimized.mockReturnValue(false);
    mockGetAllWindows.mockReturnValue([makeWindow()]);
  });

  describe('notifyPermissionRequest', () => {
    it('shows a notification when app is not focused and notifications are enabled', () => {
      notifyPermissionRequest('bash');

      expect(mockShow).toHaveBeenCalled();
      expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('does not show notification when app is focused', () => {
      mockIsFocused.mockReturnValue(true);

      notifyPermissionRequest('bash');

      expect(mockShow).not.toHaveBeenCalled();
    });

    it('does not show notification when notifications are disabled', () => {
      mockConfigGet.mockReturnValue(false);

      notifyPermissionRequest('bash');

      expect(mockShow).not.toHaveBeenCalled();
    });

    it('does not show notification when Notification.isSupported returns false', () => {
      mockIsSupported.mockReturnValue(false);

      notifyPermissionRequest('bash');

      expect(mockShow).not.toHaveBeenCalled();
    });
  });

  describe('notifyAgentComplete', () => {
    it('shows a notification when app is not focused', () => {
      notifyAgentComplete('My Task');

      expect(mockShow).toHaveBeenCalled();
    });

    it('shows a notification when no session title is provided', () => {
      notifyAgentComplete(undefined);

      expect(mockShow).toHaveBeenCalled();
    });

    it('does not show notification when app is focused', () => {
      mockIsFocused.mockReturnValue(true);

      notifyAgentComplete('My Task');

      expect(mockShow).not.toHaveBeenCalled();
    });

    it('does not show notification when notifications are disabled', () => {
      mockConfigGet.mockReturnValue(false);

      notifyAgentComplete('My Task');

      expect(mockShow).not.toHaveBeenCalled();
    });
  });

  describe('click-to-focus behavior', () => {
    it('registers a click handler that focuses the app', () => {
      notifyPermissionRequest('write');

      expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));

      // Simulate click
      const clickHandler = mockOn.mock.calls[0][1];
      clickHandler();

      expect(mockWindowShow).toHaveBeenCalled();
      expect(mockWindowFocus).toHaveBeenCalled();
    });

    it('restores minimized window on click', () => {
      mockIsMinimized.mockReturnValue(true);

      notifyPermissionRequest('write');

      const clickHandler = mockOn.mock.calls[0][1];
      clickHandler();

      expect(mockRestore).toHaveBeenCalled();
      expect(mockWindowShow).toHaveBeenCalled();
      expect(mockWindowFocus).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('does not crash when no windows exist', () => {
      mockGetAllWindows.mockReturnValue([]);

      // getMainWindow returns null → isAppFocused returns false
      // notification will still fire (no window ≠ focused)
      expect(() => notifyPermissionRequest('bash')).not.toThrow();
    });

    it('handles all windows destroyed gracefully', () => {
      mockIsDestroyed.mockReturnValue(true);
      mockGetAllWindows.mockReturnValue([makeWindow()]);

      // All windows destroyed → getMainWindow returns null → not focused
      expect(() => notifyAgentComplete('test')).not.toThrow();
    });
  });
});
