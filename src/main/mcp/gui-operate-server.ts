/**
 * GUI Operate MCP Server
 * 
 * This MCP server provides GUI automation capabilities for macOS:
 * - Click (single click, double click, right click)
 * - Type text (keyboard input)
 * - Scroll (mouse wheel scroll)
 * - Screenshot (capture screen or specific display)
 * - Get display information (multi-monitor support)
 * 
 * Multi-display support:
 * - All operations support display_index parameter
 * - Coordinates are automatically adjusted based on display configuration
 * - Display index 0 is the main display, others are secondary displays
 * 
 * Uses cliclick for macOS (brew install cliclick)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

// ============================================================================
// Display Information Types
// ============================================================================

interface DisplayInfo {
  index: number;
  name: string;
  isMain: boolean;
  width: number;
  height: number;
  originX: number;  // Global coordinate origin X
  originY: number;  // Global coordinate origin Y
  scaleFactor: number;  // Retina scale factor
}

interface DisplayConfiguration {
  displays: DisplayInfo[];
  totalWidth: number;
  totalHeight: number;
  mainDisplayIndex: number;
}

// Cache for display configuration
let displayConfigCache: DisplayConfiguration | null = null;
let displayConfigCacheTime: number = 0;
const DISPLAY_CONFIG_CACHE_TTL = 5000; // 5 seconds cache

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Execute a shell command with timeout
 */
async function executeCommand(
  command: string,
  timeout: number = 10000
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execAsync(command, { timeout });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error: any) {
    throw new Error(`Command execution failed: ${error.message}`);
  }
}

/**
 * Check if cliclick is installed
 */
async function checkCliclickInstalled(): Promise<boolean> {
  try {
    await executeCommand('which cliclick');
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute cliclick command with error handling
 */
async function executeCliclick(command: string): Promise<{ stdout: string; stderr: string }> {
  const platform = os.platform();
  
  if (platform !== 'darwin') {
    throw new Error('This MCP server only supports macOS. cliclick is only available on macOS.');
  }
  
  const isInstalled = await checkCliclickInstalled();
  if (!isInstalled) {
    throw new Error('cliclick is not installed. Install it with: brew install cliclick');
  }
  
  return await executeCommand(`cliclick ${command}`);
}

// ============================================================================
// Display Information Functions
// ============================================================================

/**
 * Get display configuration using system_profiler and AppleScript
 * Returns information about all connected displays
 */
async function getDisplayConfiguration(): Promise<DisplayConfiguration> {
  // Check cache
  const now = Date.now();
  if (displayConfigCache && (now - displayConfigCacheTime) < DISPLAY_CONFIG_CACHE_TTL) {
    return displayConfigCache;
  }
  
  const platform = os.platform();
  
  if (platform !== 'darwin') {
    throw new Error('Display detection is only supported on macOS.');
  }
  
  try {
    // Use AppleScript to get accurate display information
    // This provides the actual coordinate system used by the OS
    const appleScript = `
      use framework "AppKit"
      use scripting additions
      
      set displayList to ""
      set screenCount to (current application's NSScreen's screens()'s |count|())
      
      repeat with i from 1 to screenCount
        set theScreen to (current application's NSScreen's screens()'s objectAtIndex:(i - 1))
        set theFrame to theScreen's frame()
        set theVisibleFrame to theScreen's visibleFrame()
        
        -- Get display name (if available)
        set displayName to "Display " & i
        
        -- Check if this is the main display
        set isMain to (theScreen's isEqual:(current application's NSScreen's mainScreen())) as boolean
        
        -- Get coordinates
        set originX to (current application's NSMinX(theFrame)) as integer
        set originY to (current application's NSMinY(theFrame)) as integer
        set screenWidth to (current application's NSWidth(theFrame)) as integer
        set screenHeight to (current application's NSHeight(theFrame)) as integer
        
        -- Get scale factor (for Retina displays)
        set scaleFactor to (theScreen's backingScaleFactor()) as real
        
        set displayInfo to "index:" & (i - 1) & ",name:" & displayName & ",isMain:" & isMain & ",width:" & screenWidth & ",height:" & screenHeight & ",originX:" & originX & ",originY:" & originY & ",scaleFactor:" & scaleFactor
        
        if displayList is "" then
          set displayList to displayInfo
        else
          set displayList to displayList & "|" & displayInfo
        end if
      end repeat
      
      return displayList
    `;
    
    const result = await executeCommand(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`);
    const output = result.stdout.trim();
    
    if (!output) {
      throw new Error('No display information returned from AppleScript');
    }
    
    // Parse the display information
    const displays: DisplayInfo[] = [];
    const displayStrings = output.split('|');
    
    for (const displayStr of displayStrings) {
      const props: Record<string, string> = {};
      for (const prop of displayStr.split(',')) {
        const [key, value] = prop.split(':');
        if (key && value !== undefined) {
          props[key] = value;
        }
      }
      
      displays.push({
        index: parseInt(props['index'] || '0'),
        name: props['name'] || 'Unknown Display',
        isMain: props['isMain'] === 'true',
        width: parseInt(props['width'] || '1920'),
        height: parseInt(props['height'] || '1080'),
        originX: parseInt(props['originX'] || '0'),
        originY: parseInt(props['originY'] || '0'),
        scaleFactor: parseFloat(props['scaleFactor'] || '1.0'),
      });
    }
    
    // Sort displays by index
    displays.sort((a, b) => a.index - b.index);
    
    // Calculate total dimensions
    let totalWidth = 0;
    let totalHeight = 0;
    let mainDisplayIndex = 0;
    
    for (const display of displays) {
      const right = display.originX + display.width;
      const bottom = Math.abs(display.originY) + display.height;
      
      if (right > totalWidth) {
        totalWidth = right;
      }
      if (bottom > totalHeight) {
        totalHeight = bottom;
      }
      if (display.isMain) {
        mainDisplayIndex = display.index;
      }
    }
    
    const config: DisplayConfiguration = {
      displays,
      totalWidth,
      totalHeight,
      mainDisplayIndex,
    };
    
    // Update cache
    displayConfigCache = config;
    displayConfigCacheTime = now;
    
    return config;
  } catch (error: any) {
    // Fallback: Use system_profiler for basic info
    console.error('AppleScript display detection failed, using fallback:', error.message);
    
    try {
      const result = await executeCommand('system_profiler SPDisplaysDataType -json');
      const data = JSON.parse(result.stdout);
      const displays: DisplayInfo[] = [];
      
      let index = 0;
      for (const gpu of data.SPDisplaysDataType || []) {
        for (const display of gpu.spdisplays_ndrvs || []) {
          const resolution = display._spdisplays_resolution || '';
          const match = resolution.match(/(\d+)\s*x\s*(\d+)/);
          
          displays.push({
            index,
            name: display._name || `Display ${index + 1}`,
            isMain: display.spdisplays_main === 'spdisplays_yes',
            width: match ? parseInt(match[1]) : 1920,
            height: match ? parseInt(match[2]) : 1080,
            originX: 0,  // system_profiler doesn't provide origin
            originY: 0,
            scaleFactor: resolution.includes('Retina') ? 2.0 : 1.0,
          });
          index++;
        }
      }
      
      // If no displays found, return default
      if (displays.length === 0) {
        displays.push({
          index: 0,
          name: 'Main Display',
          isMain: true,
          width: 1920,
          height: 1080,
          originX: 0,
          originY: 0,
          scaleFactor: 1.0,
        });
      }
      
      const config: DisplayConfiguration = {
        displays,
        totalWidth: displays.reduce((max, d) => Math.max(max, d.originX + d.width), 0),
        totalHeight: displays.reduce((max, d) => Math.max(max, Math.abs(d.originY) + d.height), 0),
        mainDisplayIndex: displays.findIndex(d => d.isMain) || 0,
      };
      
      displayConfigCache = config;
      displayConfigCacheTime = now;
      
      return config;
    } catch (fallbackError: any) {
      throw new Error(`Failed to get display information: ${fallbackError.message}`);
    }
  }
}

/**
 * Convert display-local coordinates to global screen coordinates
 * 
 * In macOS, the coordinate system is:
 * - Main display origin is (0, 0) at bottom-left
 * - Secondary displays have origins relative to main display
 * - Y-axis increases upward in Cocoa, but cliclick uses top-left origin
 * 
 * This function converts (x, y) relative to a specific display
 * to global coordinates that cliclick can use
 */
async function convertToGlobalCoordinates(
  x: number,
  y: number,
  displayIndex: number = 0
): Promise<{ globalX: number; globalY: number }> {
  const config = await getDisplayConfiguration();
  
  // Find the target display
  const display = config.displays.find(d => d.index === displayIndex);
  if (!display) {
    throw new Error(`Display index ${displayIndex} not found. Available displays: 0-${config.displays.length - 1}`);
  }
  
  // Validate coordinates are within display bounds
  if (x < 0 || x >= display.width || y < 0 || y >= display.height) {
    console.warn(`Warning: Coordinates (${x}, ${y}) may be outside display ${displayIndex} bounds (${display.width}x${display.height})`);
  }
  
  // In macOS:
  // - cliclick uses screen coordinates with origin at top-left of the main display
  // - For multi-monitor setups, secondary displays extend the coordinate space
  // - originX and originY from NSScreen are in Cocoa coordinates (bottom-left origin)
  
  // For cliclick, we need top-left origin coordinates
  // macOS coordinate system: originY is 0 for main display at bottom-left
  // cliclick expects: (0,0) at top-left of main display
  
  // Calculate global coordinates for cliclick
  // originX is already correct (left edge position)
  // For Y: we need to flip the coordinate system
  
  const globalX = display.originX + x;
  
  // Find the bottom-most point in the coordinate system
  // In Cocoa, displays above main have positive originY, displays below have negative
  // For cliclick, Y increases downward from top of main display
  
  // If the display has originY >= 0 (above or at main display level)
  // The global Y for cliclick = (main display height - (display.originY + display.height)) + y
  // But this is complex with multiple displays...
  
  // Simplified approach: since cliclick coordinates are relative to the entire screen space
  // and macOS reports originY in Cocoa coordinates, we can use:
  // Note: mainDisplay info is available via config.displays.find(d => d.isMain)
  
  // For displays arranged horizontally (same Y level as main)
  // globalY = y (relative to top of that display)
  // For displays above/below main, we need to adjust
  
  // In practice, for horizontal arrangements (most common):
  const globalY = y - display.originY;  // Adjust for display's Y offset
  
  return { globalX, globalY };
}

// ============================================================================
// GUI Operation Functions
// ============================================================================

/**
 * Perform a click operation
 */
async function performClick(
  x: number,
  y: number,
  displayIndex: number = 0,
  clickType: 'single' | 'double' | 'right' | 'triple' = 'single',
  modifiers: string[] = []
): Promise<string> {
  const { globalX, globalY } = await convertToGlobalCoordinates(x, y, displayIndex);
  
  // Build cliclick command
  let command = '';
  
  // Add modifiers (if any)
  const modifierMap: Record<string, string> = {
    'command': 'cmd',
    'cmd': 'cmd',
    'shift': 'shift',
    'option': 'alt',
    'alt': 'alt',
    'control': 'ctrl',
    'ctrl': 'ctrl',
  };
  
  const cliclickModifiers = modifiers
    .map(m => modifierMap[m.toLowerCase()])
    .filter(m => m)
    .join(',');
  
  // Build click command based on type
  switch (clickType) {
    case 'double':
      command = `dc:${globalX},${globalY}`;
      break;
    case 'right':
      command = `rc:${globalX},${globalY}`;
      break;
    case 'triple':
      command = `tc:${globalX},${globalY}`;
      break;
    case 'single':
    default:
      command = `c:${globalX},${globalY}`;
      break;
  }
  
  // Add modifier key handling
  if (cliclickModifiers) {
    // Hold modifier keys, click, release
    command = `kd:${cliclickModifiers} ${command} ku:${cliclickModifiers}`;
  }
  
  await executeCliclick(command);
  
  return `Performed ${clickType} click at (${x}, ${y}) on display ${displayIndex} (global: ${globalX}, ${globalY})`;
}

/**
 * Perform keyboard input
 */
async function performType(
  text: string,
  pressEnter: boolean = false
): Promise<string> {
  // cliclick uses t: for typing - double quotes are escaped inside the string
  const escapedText = text.replace(/"/g, '\\"');
  
  let command = `t:"${escapedText}"`;
  
  if (pressEnter) {
    command += ' kp:return';
  }
  
  await executeCliclick(command);
  
  return `Typed: "${text}"${pressEnter ? ' and pressed Enter' : ''}`;
}

/**
 * Press a key or key combination
 */
async function performKeyPress(
  key: string,
  modifiers: string[] = []
): Promise<string> {
  // Map common key names to cliclick key codes
  const keyMap: Record<string, string> = {
    'enter': 'return',
    'return': 'return',
    'tab': 'tab',
    'escape': 'esc',
    'esc': 'esc',
    'space': 'space',
    'delete': 'delete',
    'backspace': 'delete',
    'up': 'arrow-up',
    'down': 'arrow-down',
    'left': 'arrow-left',
    'right': 'arrow-right',
    'home': 'home',
    'end': 'end',
    'pageup': 'page-up',
    'pagedown': 'page-down',
    'f1': 'f1',
    'f2': 'f2',
    'f3': 'f3',
    'f4': 'f4',
    'f5': 'f5',
    'f6': 'f6',
    'f7': 'f7',
    'f8': 'f8',
    'f9': 'f9',
    'f10': 'f10',
    'f11': 'f11',
    'f12': 'f12',
  };
  
  const cliclickKey = keyMap[key.toLowerCase()] || key;
  
  // Handle modifiers
  const modifierMap: Record<string, string> = {
    'command': 'cmd',
    'cmd': 'cmd',
    'shift': 'shift',
    'option': 'alt',
    'alt': 'alt',
    'control': 'ctrl',
    'ctrl': 'ctrl',
  };
  
  const cliclickModifiers = modifiers
    .map(m => modifierMap[m.toLowerCase()])
    .filter(m => m);
  
  let command = '';
  
  if (cliclickModifiers.length > 0) {
    command = `kd:${cliclickModifiers.join(',')} kp:${cliclickKey} ku:${cliclickModifiers.join(',')}`;
  } else {
    command = `kp:${cliclickKey}`;
  }
  
  await executeCliclick(command);
  
  const modifierStr = modifiers.length > 0 ? `${modifiers.join('+')}+` : '';
  return `Pressed: ${modifierStr}${key}`;
}

/**
 * Perform scroll operation
 */
async function performScroll(
  x: number,
  y: number,
  displayIndex: number = 0,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number = 3
): Promise<string> {
  const { globalX, globalY } = await convertToGlobalCoordinates(x, y, displayIndex);
  
  // First move to the position
  const moveCommand = `m:${globalX},${globalY}`;
  
  // cliclick doesn't directly support scrolling, but we can use AppleScript
  // via osascript for more reliable scrolling
  
  // Use cliclick's move command first
  await executeCliclick(moveCommand);
  
  // Use Python with pyobjc for scrolling via CGEventCreateScrollWheelEvent
  // This is the most reliable method for programmatic scrolling on macOS
  const scrollY = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  const scrollX = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
  
  const scrollScript = `
import Quartz
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${scrollY}, ${scrollX})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
  `.trim().replace(/\n/g, '; ');
  
  try {
    await executeCommand(`python3 -c "${scrollScript}"`);
  } catch {
    // Fallback: try using AppleScript with key simulation
    // This is a rough approximation for systems without pyobjc
    const keyCode = direction === 'up' ? '126' : direction === 'down' ? '125' : direction === 'left' ? '123' : '124';
    const repeatCount = Math.min(amount, 10);
    
    for (let i = 0; i < repeatCount; i++) {
      try {
        await executeCommand(`osascript -e 'tell application "System Events" to key code ${keyCode}'`);
      } catch {
        break;
      }
    }
    console.warn('Python scroll failed, using key-based approximation');
  }
  
  return `Scrolled ${direction} by ${amount} at (${x}, ${y}) on display ${displayIndex}`;
}

/**
 * Perform drag operation
 */
async function performDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  displayIndex: number = 0
): Promise<string> {
  const fromCoords = await convertToGlobalCoordinates(fromX, fromY, displayIndex);
  const toCoords = await convertToGlobalCoordinates(toX, toY, displayIndex);
  
  // cliclick drag command: dd: (drag down/start) then du: (drag up/end)
  const command = `dd:${fromCoords.globalX},${fromCoords.globalY} du:${toCoords.globalX},${toCoords.globalY}`;
  
  await executeCliclick(command);
  
  return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}) on display ${displayIndex}`;
}

/**
 * Take a screenshot
 */
async function takeScreenshot(
  outputPath?: string,
  displayIndex?: number,
  region?: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const timestamp = Date.now();
  const defaultPath = path.join(os.tmpdir(), `screenshot_${timestamp}.png`);
  const finalPath = outputPath || defaultPath;
  
  let command = 'screencapture';
  
  // -x: no sound
  command += ' -x';
  
  // If specific display requested
  if (displayIndex !== undefined) {
    const config = await getDisplayConfiguration();
    const display = config.displays.find(d => d.index === displayIndex);
    
    if (!display) {
      throw new Error(`Display index ${displayIndex} not found.`);
    }
    
    // -D: capture specific display (1-indexed for screencapture)
    command += ` -D ${displayIndex + 1}`;
  }
  
  // If region specified
  if (region) {
    const { globalX, globalY } = displayIndex !== undefined
      ? await convertToGlobalCoordinates(region.x, region.y, displayIndex)
      : { globalX: region.x, globalY: region.y };
    
    // -R: capture specific region (x,y,width,height)
    command += ` -R ${globalX},${globalY},${region.width},${region.height}`;
  }
  
  command += ` "${finalPath}"`;
  
  await executeCommand(command);
  
  // Verify the file was created
  try {
    await fs.access(finalPath);
    
    // Get file info
    const stats = await fs.stat(finalPath);
    
    return JSON.stringify({
      success: true,
      path: finalPath,
      size: stats.size,
      displayIndex: displayIndex ?? 'all',
      timestamp: new Date().toISOString(),
    });
  } catch {
    throw new Error(`Screenshot file was not created at ${finalPath}`);
  }
}

/**
 * Get current mouse position
 */
async function getMousePosition(): Promise<{ x: number; y: number; displayIndex: number }> {
  const result = await executeCliclick('p');
  // Output format: "x,y" or similar
  const match = result.stdout.trim().match(/(\d+),(\d+)/);
  
  if (!match) {
    throw new Error(`Failed to parse mouse position: ${result.stdout}`);
  }
  
  const globalX = parseInt(match[1]);
  const globalY = parseInt(match[2]);
  
  // Find which display this position is on
  const config = await getDisplayConfiguration();
  let foundDisplay = config.displays[0];
  
  for (const display of config.displays) {
    if (
      globalX >= display.originX &&
      globalX < display.originX + display.width &&
      globalY >= Math.min(display.originY, 0) &&
      globalY < Math.abs(display.originY) + display.height
    ) {
      foundDisplay = display;
      break;
    }
  }
  
  // Convert to display-local coordinates
  const localX = globalX - foundDisplay.originX;
  const localY = globalY + foundDisplay.originY;
  
  return {
    x: localX,
    y: localY,
    displayIndex: foundDisplay.index,
  };
}

/**
 * Move mouse to position
 */
async function moveMouse(
  x: number,
  y: number,
  displayIndex: number = 0
): Promise<string> {
  const { globalX, globalY } = await convertToGlobalCoordinates(x, y, displayIndex);
  
  await executeCliclick(`m:${globalX},${globalY}`);
  
  return `Moved mouse to (${x}, ${y}) on display ${displayIndex}`;
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: 'gui-operate',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_displays',
        description: 'Get information about all connected displays. Returns display index, name, resolution, position, and scale factor. Use this to understand the multi-monitor setup before performing GUI operations.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'click',
        description: 'Perform a mouse click at specified coordinates. Supports single click, double click, right click, and triple click. Coordinates are relative to the specified display.',
        inputSchema: {
          type: 'object',
          properties: {
            x: {
              type: 'number',
              description: 'X coordinate relative to the display (0 = left edge)',
            },
            y: {
              type: 'number',
              description: 'Y coordinate relative to the display (0 = top edge)',
            },
            display_index: {
              type: 'number',
              description: 'Display index (0 = main display). Use get_displays to see available displays. Default: 0',
            },
            click_type: {
              type: 'string',
              enum: ['single', 'double', 'right', 'triple'],
              description: 'Type of click to perform. Default: single',
            },
            modifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Modifier keys to hold during click: command, shift, option/alt, control/ctrl',
            },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'type_text',
        description: 'Type text using the keyboard. The text will be typed at the current cursor/focus position.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text to type',
            },
            press_enter: {
              type: 'boolean',
              description: 'Whether to press Enter after typing. Default: false',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'key_press',
        description: 'Press a key or key combination. Useful for special keys like Enter, Tab, Escape, arrow keys, or shortcuts like Cmd+C.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Key to press: enter, tab, escape, space, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, or a single character',
            },
            modifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Modifier keys: command/cmd, shift, option/alt, control/ctrl',
            },
          },
          required: ['key'],
        },
      },
      {
        name: 'scroll',
        description: 'Perform a scroll operation at the specified position.',
        inputSchema: {
          type: 'object',
          properties: {
            x: {
              type: 'number',
              description: 'X coordinate to scroll at',
            },
            y: {
              type: 'number',
              description: 'Y coordinate to scroll at',
            },
            display_index: {
              type: 'number',
              description: 'Display index. Default: 0',
            },
            direction: {
              type: 'string',
              enum: ['up', 'down', 'left', 'right'],
              description: 'Scroll direction',
            },
            amount: {
              type: 'number',
              description: 'Scroll amount (number of lines). Default: 3',
            },
          },
          required: ['x', 'y', 'direction'],
        },
      },
      {
        name: 'drag',
        description: 'Perform a drag operation from one point to another.',
        inputSchema: {
          type: 'object',
          properties: {
            from_x: {
              type: 'number',
              description: 'Starting X coordinate',
            },
            from_y: {
              type: 'number',
              description: 'Starting Y coordinate',
            },
            to_x: {
              type: 'number',
              description: 'Ending X coordinate',
            },
            to_y: {
              type: 'number',
              description: 'Ending Y coordinate',
            },
            display_index: {
              type: 'number',
              description: 'Display index. Default: 0',
            },
          },
          required: ['from_x', 'from_y', 'to_x', 'to_y'],
        },
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot of the screen, a specific display, or a region.',
        inputSchema: {
          type: 'object',
          properties: {
            output_path: {
              type: 'string',
              description: 'Path to save the screenshot. If not provided, saves to temp directory.',
            },
            display_index: {
              type: 'number',
              description: 'Display index to capture. If not provided, captures all displays.',
            },
            region: {
              type: 'object',
              description: 'Capture a specific region',
              properties: {
                x: { type: 'number', description: 'X coordinate of region' },
                y: { type: 'number', description: 'Y coordinate of region' },
                width: { type: 'number', description: 'Width of region' },
                height: { type: 'number', description: 'Height of region' },
              },
              required: ['x', 'y', 'width', 'height'],
            },
          },
          required: [],
        },
      },
      {
        name: 'get_mouse_position',
        description: 'Get the current mouse cursor position, including which display it is on.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'move_mouse',
        description: 'Move the mouse cursor to a specified position without clicking.',
        inputSchema: {
          type: 'object',
          properties: {
            x: {
              type: 'number',
              description: 'X coordinate',
            },
            y: {
              type: 'number',
              description: 'Y coordinate',
            },
            display_index: {
              type: 'number',
              description: 'Display index. Default: 0',
            },
          },
          required: ['x', 'y'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    let result: string;
    
    switch (name) {
      case 'get_displays': {
        const config = await getDisplayConfiguration();
        result = JSON.stringify(config, null, 2);
        break;
      }
      
      case 'click': {
        const { x, y, display_index = 0, click_type = 'single', modifiers = [] } = args as {
          x: number;
          y: number;
          display_index?: number;
          click_type?: 'single' | 'double' | 'right' | 'triple';
          modifiers?: string[];
        };
        result = await performClick(x, y, display_index, click_type, modifiers);
        break;
      }
      
      case 'type_text': {
        const { text, press_enter = false } = args as {
          text: string;
          press_enter?: boolean;
        };
        result = await performType(text, press_enter);
        break;
      }
      
      case 'key_press': {
        const { key, modifiers = [] } = args as {
          key: string;
          modifiers?: string[];
        };
        result = await performKeyPress(key, modifiers);
        break;
      }
      
      case 'scroll': {
        const { x, y, display_index = 0, direction, amount = 3 } = args as {
          x: number;
          y: number;
          display_index?: number;
          direction: 'up' | 'down' | 'left' | 'right';
          amount?: number;
        };
        result = await performScroll(x, y, display_index, direction, amount);
        break;
      }
      
      case 'drag': {
        const { from_x, from_y, to_x, to_y, display_index = 0 } = args as {
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          display_index?: number;
        };
        result = await performDrag(from_x, from_y, to_x, to_y, display_index);
        break;
      }
      
      case 'screenshot': {
        const { output_path, display_index, region } = args as {
          output_path?: string;
          display_index?: number;
          region?: { x: number; y: number; width: number; height: number };
        };
        result = await takeScreenshot(output_path, display_index, region);
        break;
      }
      
      case 'get_mouse_position': {
        const position = await getMousePosition();
        result = JSON.stringify(position, null, 2);
        break;
      }
      
      case 'move_mouse': {
        const { x, y, display_index = 0 } = args as {
          x: number;
          y: number;
          display_index?: number;
        };
        result = await moveMouse(x, y, display_index);
        break;
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: true,
            message: error.message,
            tool: name,
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GUI Operate MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
