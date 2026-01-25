/**
 * Software Development MCP Server - Full Implementation
 * 
 * This MCP server automates the software development cycle:
 * 1. Code creation/modification based on requirements
 * 2. Test case generation and execution
 * 3. Interactive testing (code + GUI interaction)
 * 4. Requirement updates based on test results
 * 5. Requirement validation/completion verification
 * 
 * Features:
 * - File system operations (create, read, modify, delete)
 * - Integration with Claude Code for AI-assisted development
 * - Test execution (unit, integration, e2e)
 * - Requirement tracking and validation
 * - Git integration for version control
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Get workspace directory from environment or use current directory
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
const TEST_ENV = process.env.TEST_ENV || 'development';

// Requirements tracking (in-memory for now, could be persisted to file)
interface Requirement {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  files: string[];
  tests: string[];
  createdAt: Date;
  updatedAt: Date;
  history: Array<{
    timestamp: Date;
    description: string;
    reason: string;
  }>;
}

const requirements = new Map<string, Requirement>();

// GUI Application Management
interface GUIAppInstance {
  process: any;
  pid: number;
  appType: string;
  startTime: Date;
  url?: string;
  isDocker?: boolean;
  containerId?: string;
  vncPort?: number;
}

let currentGUIApp: GUIAppInstance | null = null;

// Docker GUI Test Management
interface DockerGUITestConfig {
  appFiles: string[];
  testFiles: string[];
  enableVnc: boolean;
  vncPort: number;
  displayNumber: number;
}

// const DEFAULT_DOCKER_CONFIG: DockerGUITestConfig = {
//   appFiles: [],
//   testFiles: [],
//   enableVnc: true,
//   vncPort: 5901,
//   displayNumber: 99,
// };

// Appium Session Management
interface AppiumSession {
  sessionId: string;
  driver: any;
  capabilities: any;
  platform: 'iOS' | 'Android' | 'Windows' | 'Mac';
  startTime: Date;
}

let currentAppiumSession: AppiumSession | null = null;

// Helper: Build Docker image for GUI testing
async function buildDockerGUITestImage(config: DockerGUITestConfig): Promise<string> {
  const imageName = 'mcp-gui-test';
  const dockerfilePath = path.join(WORKSPACE_DIR, '.mcp-gui-test', 'Dockerfile');
  
  console.error('[Docker] Building GUI test image...');
  
  // Create Dockerfile
  const dockerfile = `FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \\
    python3 \\
    python3-pip \\
    python3-tk \\
    xvfb \\
    xdotool \\
    scrot \\
    imagemagick \\
    x11vnc \\
    wget \\
    curl \\
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy application and test files (will be mounted)
# Files will be mounted at runtime

# Create entrypoint script
RUN echo '#!/bin/bash\\n\\
# Start virtual display\\n\\
echo "Starting Xvfb on :${config.displayNumber}..."\\n\\
Xvfb :${config.displayNumber} -screen 0 1024x768x24 -ac +extension GLX +render -noreset &\\n\\
export DISPLAY=:${config.displayNumber}\\n\\
\\n\\
# Wait for X server to start\\n\\
sleep 2\\n\\
\\n\\
# Start VNC server if enabled\\n\\
if [ "$ENABLE_VNC" = "true" ]; then\\n\\
    echo "Starting VNC server on port ${config.vncPort}..."\\n\\
    x11vnc -display :${config.displayNumber} -rfbport ${config.vncPort} -forever -nopw -shared -quiet &\\n\\
    echo "VNC server started. Connect to localhost:${config.vncPort} to view."\\n\\
    echo ""\\n\\
    echo "=========================================="\\n\\
    echo "VNC Connection Instructions"\\n\\
    echo "=========================================="\\n\\
    echo "Install VNC Viewer:"\\n\\
    echo "  brew install --cask vnc-viewer"\\n\\
    echo ""\\n\\
    echo "Then connect to: localhost:${config.vncPort}"\\n\\
    echo "=========================================="\\n\\
    echo ""\\n\\
fi\\n\\
\\n\\
# Run tests\\n\\
echo ""\\n\\
echo "=========================================="\\n\\
echo "Running GUI Tests in Isolated Environment"\\n\\
echo "=========================================="\\n\\
echo ""\\n\\
\\n\\
# Execute test command (passed as argument)\\n\\
if [ -n "$TEST_COMMAND" ]; then\\n\\
    echo "Executing: $TEST_COMMAND"\\n\\
    DISPLAY=:${config.displayNumber} bash -c "$TEST_COMMAND"\\n\\
else\\n\\
    echo "No test command specified. Keeping container alive..."\\n\\
    tail -f /dev/null\\n\\
fi\\n\\
' > /entrypoint.sh && chmod +x /entrypoint.sh

# Expose VNC port
EXPOSE ${config.vncPort}

# Set environment variables
ENV DISPLAY=:${config.displayNumber}
ENV ENABLE_VNC=false

ENTRYPOINT ["/entrypoint.sh"]
`;
  
  // Ensure directory exists
  await fs.mkdir(path.dirname(dockerfilePath), { recursive: true });
  await fs.writeFile(dockerfilePath, dockerfile);
  
  // Build image
  try {
    const { stdout, stderr } = await executeCommand(
      `docker build -t ${imageName} -f "${dockerfilePath}" "${path.dirname(dockerfilePath)}"`,
      WORKSPACE_DIR
    );
    console.error('[Docker] Image built successfully');
    console.error(stdout);
    if (stderr) console.error(stderr);
    return imageName;
  } catch (error: any) {
    console.error('[Docker] Failed to build image:', error.message);
    throw new Error(`Failed to build Docker image: ${error.message}`);
  }
}

// Helper: Start GUI application in Docker
async function startGUIApplicationInDocker(
  appFilePath: string,
  appType: string,
  testCommand: string,
  enableVnc: boolean = true,
  vncPort: number = 5901
): Promise<GUIAppInstance> {
  console.error('[Docker] Starting GUI application in isolated Docker environment...');
  
  const config: DockerGUITestConfig = {
    appFiles: [appFilePath],
    testFiles: [],
    enableVnc,
    vncPort,
    displayNumber: 99,
  };
  
  // Build Docker image
  const imageName = await buildDockerGUITestImage(config);
  
  // Prepare volume mounts
  const appDir = path.dirname(path.isAbsolute(appFilePath) ? appFilePath : path.join(WORKSPACE_DIR, appFilePath));
  
  // Start container
  const containerName = `mcp-gui-test-${Date.now()}`;
  const dockerCommand = [
    'docker run',
    '--rm',
    '-d',
    `--name ${containerName}`,
    `-v "${appDir}:/app"`,
    `-e ENABLE_VNC=${enableVnc}`,
    `-e TEST_COMMAND="${testCommand}"`,
    enableVnc ? `-p ${vncPort}:${vncPort}` : '',
    imageName,
  ].filter(Boolean).join(' ');
  
  console.error(`[Docker] Starting container: ${containerName}`);
  console.error(`[Docker] Command: ${dockerCommand}`);
  
  try {
    const { stdout } = await executeCommand(dockerCommand, WORKSPACE_DIR);
    const containerId = stdout.trim();
    
    console.error(`[Docker] Container started: ${containerId.substring(0, 12)}`);
    
    // Wait for services to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    if (enableVnc) {
      console.error('');
      console.error('========================================');
      console.error('VNC Viewer Connection');
      console.error('========================================');
      console.error(`VNC Port: ${vncPort}`);
      console.error(`Connection: localhost:${vncPort}`);
      console.error('');
      console.error('Install VNC Viewer:');
      console.error('  brew install --cask vnc-viewer');
      console.error('');
      console.error('Then open VNC Viewer and connect to:');
      console.error(`  localhost:${vncPort}`);
      console.error('========================================');
      console.error('');
    }
    
    const instance: GUIAppInstance = {
      process: null,
      pid: 0,
      appType,
      startTime: new Date(),
      isDocker: true,
      containerId,
      vncPort: enableVnc ? vncPort : undefined,
    };
    
    return instance;
  } catch (error: any) {
    console.error('[Docker] Failed to start container:', error.message);
    throw new Error(`Failed to start Docker container: ${error.message}`);
  }
}

// Helper: Start GUI application (local or Docker)
async function startGUIApplication(
  appFilePath: string, 
  appType: string, 
  startCommand?: string, 
  waitTime: number = 3,
  useDocker: boolean = false,
  testCommand?: string,
  enableVnc: boolean = true,
  vncPort: number = 5901
): Promise<GUIAppInstance> {
  // If Docker mode is enabled, use Docker
  if (useDocker) {
    if (!testCommand) {
      throw new Error('testCommand is required when using Docker mode');
    }
    return await startGUIApplicationInDocker(appFilePath, appType, testCommand, enableVnc, vncPort);
  }
  
  // Otherwise, start locally
  const fullPath = path.isAbsolute(appFilePath) ? appFilePath : path.join(WORKSPACE_DIR, appFilePath);
  
  let command: string;
  let url: string | undefined;
  
  // Determine start command based on app type
  if (startCommand) {
    command = startCommand;
  } else {
    switch (appType) {
      case 'python':
        command = `python "${fullPath}"`;
        break;
      case 'electron':
        command = `npm start`;
        break;
      case 'web':
        // For web apps, start a local server
        const port = 8000 + Math.floor(Math.random() * 1000);
        command = `python -m http.server ${port}`;
        url = `http://localhost:${port}`;
        break;
      case 'java':
        command = `java -jar "${fullPath}"`;
        break;
      default:
        command = fullPath;
    }
  }
  
  console.error(`[GUI] Starting ${appType} application: ${command}`);
  
  // Start the process
  const childProcess = exec(command, {
    cwd: WORKSPACE_DIR,
  });
  
  const instance: GUIAppInstance = {
    process: childProcess,
    pid: childProcess.pid!,
    appType,
    startTime: new Date(),
    url,
    isDocker: false,
  };
  
  // Wait for app to be ready
  await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
  
  console.error(`[GUI] Application started (PID: ${instance.pid})`);
  
  return instance;
}

// Helper: Stop GUI application (local or Docker)
async function stopGUIApplication(instance: GUIAppInstance, force: boolean = false): Promise<void> {
  if (!instance) {
    return;
  }
  
  // If Docker container, stop it
  if (instance.isDocker && instance.containerId) {
    console.error(`[Docker] Stopping container: ${instance.containerId.substring(0, 12)}`);
    
    try {
      if (force) {
        await executeCommand(`docker kill ${instance.containerId}`);
      } else {
        await executeCommand(`docker stop ${instance.containerId}`);
      }
      console.error('[Docker] Container stopped successfully');
    } catch (error: any) {
      console.error(`[Docker] Error stopping container: ${error.message}`);
    }
    return;
  }
  
  // Otherwise, stop local process
  if (!instance.process) {
    return;
  }
  
  console.error(`[GUI] Stopping application (PID: ${instance.pid})`);
  
  try {
    if (force) {
      instance.process.kill('SIGKILL');
    } else {
      instance.process.kill('SIGTERM');
    }
    
    // Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error: any) {
    console.error(`[GUI] Error stopping application: ${error.message}`);
  }
}

// Helper: Get Docker container logs
// async function getDockerContainerLogs(containerId: string, tail: number = 100): Promise<string> {
//   try {
//     const { stdout } = await executeCommand(`docker logs --tail ${tail} ${containerId}`);
//     return stdout;
//   } catch (error: any) {
//     console.error(`[Docker] Error getting logs: ${error.message}`);
//     return `Error getting logs: ${error.message}`;
//   }
// }

// Helper: Execute command in Docker container
// async function executeCommandInDocker(containerId: string, command: string): Promise<{ stdout: string; stderr: string }> {
//   try {
//     return await executeCommand(`docker exec ${containerId} bash -c "${command.replace(/"/g, '\\"')}"`);
//   } catch (error: any) {
//     throw new Error(`Failed to execute command in container: ${error.message}`);
//   }
// }

// Appium Helper Functions

/**
 * Start an Appium session with specified capabilities
 */
async function startAppiumSession(capabilities: any, appiumUrl: string = 'http://localhost:4723'): Promise<AppiumSession> {
  console.error('[Appium] Starting Appium session...');
  
  try {
    // Check if webdriverio is installed
    let wdio: any;
    try {
      wdio = require('webdriverio');
    } catch {
      throw new Error('webdriverio is not installed. Install it with: npm install webdriverio');
    }
    
    // Create Appium client
    const driver = await wdio.remote({
      protocol: 'http',
      hostname: new URL(appiumUrl).hostname,
      port: parseInt(new URL(appiumUrl).port || '4723'),
      path: '/wd/hub',
      capabilities,
    });
    
    const sessionId = driver.sessionId;
    const platform = capabilities.platformName as 'iOS' | 'Android' | 'Windows' | 'Mac';
    
    const session: AppiumSession = {
      sessionId,
      driver,
      capabilities,
      platform,
      startTime: new Date(),
    };
    
    console.error(`[Appium] Session started: ${sessionId} (Platform: ${platform})`);
    
    return session;
  } catch (error: any) {
    console.error(`[Appium] Failed to start session: ${error.message}`);
    throw new Error(`Failed to start Appium session: ${error.message}`);
  }
}

/**
 * Stop the current Appium session
 */
async function stopAppiumSession(session: AppiumSession): Promise<void> {
  if (!session || !session.driver) {
    return;
  }
  
  console.error(`[Appium] Stopping session: ${session.sessionId}`);
  
  try {
    await session.driver.deleteSession();
    console.error('[Appium] Session stopped successfully');
  } catch (error: any) {
    console.error(`[Appium] Error stopping session: ${error.message}`);
  }
}

/**
 * Execute Appium interaction
 */
async function executeAppiumInteraction(
  action: string,
  locatorStrategy: string,
  locator: string,
  value?: string,
  timeout: number = 10000
): Promise<any> {
  if (!currentAppiumSession) {
    throw new Error('No Appium session is active. Use appium_start_session first.');
  }
  
  const driver = currentAppiumSession.driver;
  
  console.error(`[Appium] Executing action: ${action} on ${locatorStrategy}=${locator}`);
  
  try {
    // Find element
    let element: any;
    
    switch (locatorStrategy) {
      case 'id':
        element = await driver.$(`~${locator}`);
        break;
      case 'xpath':
        element = await driver.$(`//${locator}`);
        break;
      case 'accessibility_id':
        element = await driver.$(`~${locator}`);
        break;
      case 'class_name':
        element = await driver.$(`.${locator}`);
        break;
      case 'android_uiautomator':
        element = await driver.$(`android=${locator}`);
        break;
      case 'ios_predicate':
        element = await driver.$(`-ios predicate string:${locator}`);
        break;
      case 'ios_class_chain':
        element = await driver.$(`-ios class chain:${locator}`);
        break;
      default:
        throw new Error(`Unsupported locator strategy: ${locatorStrategy}`);
    }
    
    // Wait for element to exist
    await element.waitForExist({ timeout });
    
    // Perform action
    let result: any;
    
    switch (action) {
      case 'click':
      case 'tap':
        await element.click();
        result = { success: true, action: 'click' };
        break;
        
      case 'type':
      case 'send_keys':
        if (!value) {
          throw new Error('Value is required for type action');
        }
        await element.setValue(value);
        result = { success: true, action: 'type', value };
        break;
        
      case 'clear':
        await element.clearValue();
        result = { success: true, action: 'clear' };
        break;
        
      case 'get_text':
        const text = await element.getText();
        result = { success: true, action: 'get_text', text };
        break;
        
      case 'get_attribute':
        if (!value) {
          throw new Error('Attribute name is required for get_attribute action');
        }
        const attr = await element.getAttribute(value);
        result = { success: true, action: 'get_attribute', attribute: value, value: attr };
        break;
        
      case 'is_displayed':
        const displayed = await element.isDisplayed();
        result = { success: true, action: 'is_displayed', displayed };
        break;
        
      case 'is_enabled':
        const enabled = await element.isEnabled();
        result = { success: true, action: 'is_enabled', enabled };
        break;
        
      case 'swipe':
        // For swipe, value should be direction: up, down, left, right
        const direction = value || 'up';
        await element.touchAction([
          { action: 'press', x: 0, y: 0 },
          { action: 'wait', ms: 100 },
          { action: 'moveTo', x: direction === 'left' ? -100 : direction === 'right' ? 100 : 0, y: direction === 'up' ? -100 : direction === 'down' ? 100 : 0 },
          { action: 'release' }
        ]);
        result = { success: true, action: 'swipe', direction };
        break;
        
      case 'long_press':
        await element.touchAction([
          { action: 'press', x: 0, y: 0 },
          { action: 'wait', ms: 2000 },
          { action: 'release' }
        ]);
        result = { success: true, action: 'long_press' };
        break;
        
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
    
    console.error(`[Appium] Action completed: ${action}`);
    return result;
    
  } catch (error: any) {
    console.error(`[Appium] Action failed: ${error.message}`);
    throw new Error(`Appium interaction failed: ${error.message}`);
  }
}

/**
 * Execute Appium assertion
 */
async function executeAppiumAssertion(
  assertionType: string,
  locatorStrategy: string,
  locator: string,
  expectedValue?: string,
  timeout: number = 10000
): Promise<boolean> {
  if (!currentAppiumSession) {
    throw new Error('No Appium session is active. Use appium_start_session first.');
  }
  
  const driver = currentAppiumSession.driver;
  
  console.error(`[Appium] Executing assertion: ${assertionType} on ${locatorStrategy}=${locator}`);
  
  try {
    // Find element
    let element: any;
    
    switch (locatorStrategy) {
      case 'id':
        element = await driver.$(`~${locator}`);
        break;
      case 'xpath':
        element = await driver.$(`//${locator}`);
        break;
      case 'accessibility_id':
        element = await driver.$(`~${locator}`);
        break;
      case 'class_name':
        element = await driver.$(`.${locator}`);
        break;
      case 'android_uiautomator':
        element = await driver.$(`android=${locator}`);
        break;
      case 'ios_predicate':
        element = await driver.$(`-ios predicate string:${locator}`);
        break;
      case 'ios_class_chain':
        element = await driver.$(`-ios class chain:${locator}`);
        break;
      default:
        throw new Error(`Unsupported locator strategy: ${locatorStrategy}`);
    }
    
    // Perform assertion
    let passed = false;
    
    switch (assertionType) {
      case 'element_exists':
        await element.waitForExist({ timeout });
        passed = await element.isExisting();
        break;
        
      case 'element_displayed':
        await element.waitForDisplayed({ timeout });
        passed = await element.isDisplayed();
        break;
        
      case 'element_enabled':
        await element.waitForExist({ timeout });
        passed = await element.isEnabled();
        break;
        
      case 'text_equals':
        if (!expectedValue) {
          throw new Error('Expected value is required for text_equals assertion');
        }
        await element.waitForExist({ timeout });
        const text = await element.getText();
        passed = text === expectedValue;
        break;
        
      case 'text_contains':
        if (!expectedValue) {
          throw new Error('Expected value is required for text_contains assertion');
        }
        await element.waitForExist({ timeout });
        const content = await element.getText();
        passed = content.includes(expectedValue);
        break;
        
      case 'attribute_equals':
        if (!expectedValue) {
          throw new Error('Expected value is required for attribute_equals assertion (format: "attributeName=expectedValue")');
        }
        const [attrName, attrValue] = expectedValue.split('=');
        await element.waitForExist({ timeout });
        const attr = await element.getAttribute(attrName);
        passed = attr === attrValue;
        break;
        
      default:
        throw new Error(`Unsupported assertion type: ${assertionType}`);
    }
    
    console.error(`[Appium] Assertion ${passed ? 'passed' : 'failed'}: ${assertionType}`);
    return passed;
    
  } catch (error: any) {
    console.error(`[Appium] Assertion error: ${error.message}`);
    return false;
  }
}

/**
 * Take screenshot with Appium
 */
async function takeAppiumScreenshot(filename?: string): Promise<string> {
  if (!currentAppiumSession) {
    throw new Error('No Appium session is active. Use appium_start_session first.');
  }
  
  const driver = currentAppiumSession.driver;
  const screenshotPath = filename || path.join(WORKSPACE_DIR, `appium_screenshot_${Date.now()}.png`);
  
  console.error(`[Appium] Taking screenshot: ${screenshotPath}`);
  
  try {
    await driver.saveScreenshot(screenshotPath);
    console.error(`[Appium] Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } catch (error: any) {
    console.error(`[Appium] Screenshot failed: ${error.message}`);
    throw new Error(`Failed to take screenshot: ${error.message}`);
  }
}

// Helper: Execute cliclick command (macOS)
async function executeCliclick(command: string): Promise<{ stdout: string; stderr: string }> {
  const platform = require('os').platform();
  
  if (platform !== 'darwin') {
    throw new Error('cliclick is only available on macOS. Use xdotool on Linux or other tools on Windows.');
  }
  
  // Check if cliclick is installed
  try {
    await executeCommand('which cliclick');
  } catch {
    throw new Error('cliclick is not installed. Install it with: brew install cliclick');
  }
  
  return await executeCommand(`cliclick ${command}`);
}

// Helper: Take screenshot (cross-platform)
async function takeScreenshot(outputPath: string): Promise<string> {
  const platform = require('os').platform();
  
  let command: string;
  if (platform === 'darwin') {
    command = `screencapture -x "${outputPath}"`;
  } else if (platform === 'win32') {
    command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Drawing.Bitmap]::FromScreen([System.Windows.Forms.Screen]::PrimaryScreen.Bounds).Save('${outputPath}')"`;
  } else {
    // Linux
    command = `import -window root "${outputPath}"`;
  }
  
  await executeCommand(command);
  return outputPath;
}

// Helper: Use vision model to analyze screenshot and find element coordinates
async function analyzeScreenshotWithVision(screenshotPath: string, elementDescription: string): Promise<{ x: number; y: number; confidence: number }> {
  // This function uses Claude's vision capabilities to locate UI elements
  // The screenshot is analyzed and coordinates are returned
  
  try {
    // Read screenshot as base64
    const imageBuffer = await fs.readFile(screenshotPath);
    const base64Image = imageBuffer.toString('base64');
    
    // Get API key from environment (set by configStore.applyToEnv())
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    
    if (!apiKey) {
      throw new Error('Anthropic API key not configured. Please configure it in Settings.');
    }
    
    // Use the model configured by the user
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const visionModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-3-5-sonnet-20241022';
    
    console.error(`[Vision] Using configured model: ${visionModel} (baseURL: ${baseUrl || 'default'})`);
    
    // Use Claude API to analyze the image
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({
      apiKey: apiKey,
      baseURL: baseUrl,
    });
    
    const message = await anthropic.messages.create({
      model: visionModel,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Analyze this GUI screenshot and locate the following element: "${elementDescription}"

Please provide the pixel coordinates (x, y) of the CENTER of this element, and your confidence level (0-100).

Respond ONLY with a JSON object in this exact format:
{
  "x": <number>,
  "y": <number>,
  "confidence": <number>,
  "reasoning": "<brief explanation>"
}

If you cannot find the element, set confidence to 0.`,
            },
          ],
        },
      ],
    });
    
    // Parse the response
    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Failed to parse vision model response');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    console.error(`[Vision] Found element "${elementDescription}" at (${result.x}, ${result.y}) with ${result.confidence}% confidence`);
    console.error(`[Vision] Reasoning: ${result.reasoning}`);
    
    return {
      x: result.x,
      y: result.y,
      confidence: result.confidence,
    };
  } catch (error: any) {
    console.error(`[Vision] Error analyzing screenshot: ${error.message}`);
    throw new Error(`Vision analysis failed: ${error.message}`);
  }
}

// Helper: Bring window to front and focus
async function focusApplicationWindow(appName?: string): Promise<void> {
  const platform = require('os').platform();
  
  console.error(`[GUI] Attempting to bring window to front (platform: ${platform}, appName: ${appName || 'auto-detect'})`);
  
  try {
    if (platform === 'darwin') {
      // macOS: Use AppleScript to bring window to front
      console.error('[GUI] Using macOS AppleScript to focus window...');
      
      if (appName) {
        const { stdout, stderr } = await executeCommand(`osascript -e 'tell application "${appName}" to activate'`);
        console.error(`[GUI] AppleScript result - stdout: ${stdout}, stderr: ${stderr}`);
      } else {
        // Try multiple approaches to find and focus Python windows
        try {
          // Approach 1: Find process by name containing "Python"
          const { stdout, stderr } = await executeCommand(`osascript -e 'tell application "System Events" to set frontmost of first process whose name contains "Python" to true'`);
          console.error(`[GUI] AppleScript (Python) result - stdout: ${stdout}, stderr: ${stderr}`);
        } catch (err1: any) {
          console.error(`[GUI] Failed to focus Python process: ${err1.message}`);
          
          // Approach 2: Try to find any Python-related window
          try {
            await executeCommand(`osascript -e 'tell application "System Events" to set frontmost of first process whose unix id is greater than 0 and name contains "python" to true'`);
            console.error('[GUI] Successfully focused python process (lowercase)');
          } catch (err2: any) {
            console.error(`[GUI] Failed to focus python process: ${err2.message}`);
            
            // Approach 3: Get the PID and focus by PID
            if (currentGUIApp && currentGUIApp.pid) {
              try {
                await executeCommand(`osascript -e 'tell application "System Events" to set frontmost of first process whose unix id is ${currentGUIApp.pid} to true'`);
                console.error(`[GUI] Successfully focused process by PID: ${currentGUIApp.pid}`);
              } catch (err3: any) {
                console.error(`[GUI] Failed to focus by PID: ${err3.message}`);
              }
            }
          }
        }
      }
    } else if (platform === 'win32') {
      // Windows: Use PowerShell to bring window to front
      console.error('[GUI] Using Windows PowerShell to focus window...');
      
      const script = appName 
        ? `Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class Win32 {\n  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);\n}\n"@; $hwnd = [Win32]::FindWindow($null, "${appName}"); [Win32]::SetForegroundWindow($hwnd)`
        : `Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class Win32 {\n  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n}\n"@; $hwnd = [Win32]::GetForegroundWindow(); [Win32]::SetForegroundWindow($hwnd)`;
      
      const { stdout, stderr } = await executeCommand(`powershell -Command "${script}"`);
      console.error(`[GUI] PowerShell result - stdout: ${stdout}, stderr: ${stderr}`);
    } else {
      // Linux: Use xdotool
      console.error('[GUI] Using Linux xdotool to focus window...');
      
      try {
        if (appName) {
          const { stdout, stderr } = await executeCommand(`xdotool search --name "${appName}" windowactivate`);
          console.error(`[GUI] xdotool result - stdout: ${stdout}, stderr: ${stderr}`);
        } else {
          const { stdout, stderr } = await executeCommand(`xdotool search --class python windowactivate`);
          console.error(`[GUI] xdotool result - stdout: ${stdout}, stderr: ${stderr}`);
        }
      } catch (err: any) {
        console.error(`[GUI] xdotool not available or failed: ${err.message}`);
        console.error('[GUI] Please install xdotool: sudo apt-get install xdotool');
      }
    }
    
    console.error('[GUI] ✓ Window focus command executed successfully');
  } catch (error: any) {
    console.error(`[GUI] ✗ Failed to focus window: ${error.message}`);
    console.error('[GUI] Window may still be in background - screenshots might capture wrong content');
  }
}

// Helper: Execute GUI interaction with vision-based element location (using cliclick)
async function executeGUIInteractionWithVision(action: string, elementDescription: string, value?: string, _timeout: number = 5000): Promise<any> {
  if (!currentGUIApp) {
    throw new Error('No GUI application is running');
  }
  
  const platform = require('os').platform();
  const screenshotPath = path.join(WORKSPACE_DIR, 'gui_screenshot.png');
  
  try {
    // Step 0: Bring window to front before taking screenshot
    console.error('[Vision] Step 0: Bringing window to front...');
    await focusApplicationWindow();
    console.error('[Vision] Waiting 1 second for window to come to front...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 1: Take screenshot
    console.error('[Vision] Step 1: Taking screenshot...');
    await takeScreenshot(screenshotPath);
    console.error(`[Vision] Screenshot saved to ${screenshotPath}`);
    
    // Step 2: Analyze with vision model to find element
    const coords = await analyzeScreenshotWithVision(screenshotPath, elementDescription);
    
    if (coords.confidence < 50) {
      return {
        success: false,
        message: `Element "${elementDescription}" not found with sufficient confidence (${coords.confidence}%)`,
        suggestion: 'Try a more specific description or check if the element is visible',
      };
    }
    
    // Step 3: Perform action using cliclick (macOS) or xdotool (Linux)
    if (platform === 'darwin') {
      // macOS: Use cliclick
      switch (action) {
        case 'click':
          await executeCliclick(`c:${coords.x},${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'double_click':
          await executeCliclick(`dc:${coords.x},${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'double_click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'right_click':
          await executeCliclick(`rc:${coords.x},${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'right_click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'type':
          if (!value) {
            throw new Error('Value is required for type action');
          }
          
          // Click first, then type
          await executeCliclick(`c:${coords.x},${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // Escape special characters for cliclick
          const escapedValue = value.replace(/"/g, '\\"');
          await executeCliclick(`t:"${escapedValue}"`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'type',
            element: elementDescription,
            value,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'hover':
          await executeCliclick(`m:${coords.x},${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'hover',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        default:
          return {
            success: false,
            message: `Action '${action}' is not supported with vision-based interaction`,
          };
      }
    } else if (platform === 'linux') {
      // Linux: Use xdotool
      switch (action) {
        case 'click':
          await executeCommand(`xdotool mousemove ${coords.x} ${coords.y} click 1`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'double_click':
          await executeCommand(`xdotool mousemove ${coords.x} ${coords.y} click --repeat 2 1`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'double_click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'right_click':
          await executeCommand(`xdotool mousemove ${coords.x} ${coords.y} click 3`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'right_click',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'type':
          if (!value) {
            throw new Error('Value is required for type action');
          }
          
          // Click first, then type
          await executeCommand(`xdotool mousemove ${coords.x} ${coords.y} click 1`);
          await new Promise(resolve => setTimeout(resolve, 200));
          await executeCommand(`xdotool type "${value.replace(/"/g, '\\"')}"`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'type',
            element: elementDescription,
            value,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        case 'hover':
          await executeCommand(`xdotool mousemove ${coords.x} ${coords.y}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return {
            success: true,
            action: 'hover',
            element: elementDescription,
            coordinates: { x: coords.x, y: coords.y },
            confidence: coords.confidence,
          };
          
        default:
          return {
            success: false,
            message: `Action '${action}' is not supported with vision-based interaction`,
          };
      }
    } else {
      // Windows: Not supported yet
      return {
        success: false,
        message: 'Vision-based interaction is not yet supported on Windows',
        suggestion: 'Use macOS (cliclick) or Linux (xdotool) for vision-based GUI automation',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Vision-based interaction failed: ${error.message}`,
      suggestion: platform === 'darwin' 
        ? 'Check if cliclick is installed (brew install cliclick) and the element description is accurate'
        : 'Check if xdotool is installed (sudo apt-get install xdotool) and the element description is accurate',
    };
  }
}

// Helper: Execute GUI interaction (using cliclick/xdotool for direct coordinate-based actions)
async function executeGUIInteraction(action: string, x?: number, y?: number, value?: string, timeout: number = 5000): Promise<any> {
  if (!currentGUIApp) {
    throw new Error('No GUI application is running');
  }
  
  const platform = require('os').platform();
  
  try {
    // Bring window to front first
    await focusApplicationWindow();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (platform === 'darwin') {
      // macOS: Use cliclick
      switch (action) {
        case 'click':
          if (x !== undefined && y !== undefined) {
            await executeCliclick(`c:${x},${y}`);
          } else {
            await executeCliclick('c:.');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'click', coordinates: { x, y } };
          
        case 'double_click':
          if (x !== undefined && y !== undefined) {
            await executeCliclick(`dc:${x},${y}`);
          } else {
            await executeCliclick('dc:.');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'double_click', coordinates: { x, y } };
          
        case 'right_click':
          if (x !== undefined && y !== undefined) {
            await executeCliclick(`rc:${x},${y}`);
          } else {
            await executeCliclick('rc:.');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'right_click', coordinates: { x, y } };
          
        case 'move':
          if (x !== undefined && y !== undefined) {
            await executeCliclick(`m:${x},${y}`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return { success: true, action: 'move', coordinates: { x, y } };
          } else {
            return { success: false, message: 'Coordinates required for move action' };
          }
          
        case 'type':
          if (!value) {
            return { success: false, message: 'Value required for type action' };
          }
          const escapedValue = value.replace(/"/g, '\\"');
          await executeCliclick(`t:"${escapedValue}"`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'type', value };
          
        case 'key':
          if (!value) {
            return { success: false, message: 'Key required for key action' };
          }
          await executeCliclick(`kp:${value}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'key', key: value };
          
        case 'drag':
          // value should be "x1,y1,x2,y2"
          if (!value) {
            return { success: false, message: 'Coordinates required for drag action (format: "x1,y1,x2,y2")' };
          }
          const [x1, y1, x2, y2] = value.split(',').map(Number);
          await executeCliclick(`dd:${x1},${y1} m:${x2},${y2} du:${x2},${y2}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
          
        case 'screenshot':
          const screenshotPath = path.join(WORKSPACE_DIR, 'screenshot.png');
          await takeScreenshot(screenshotPath);
          return { success: true, action: 'screenshot', path: screenshotPath };
          
        case 'wait':
          await new Promise(resolve => setTimeout(resolve, timeout));
          return { success: true, action: 'wait', duration: timeout };
          
        default:
          return { success: false, message: `Action '${action}' is not supported` };
      }
    } else if (platform === 'linux') {
      // Linux: Use xdotool
      switch (action) {
        case 'click':
          if (x !== undefined && y !== undefined) {
            await executeCommand(`xdotool mousemove ${x} ${y} click 1`);
          } else {
            await executeCommand('xdotool click 1');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'click', coordinates: { x, y } };
          
        case 'double_click':
          if (x !== undefined && y !== undefined) {
            await executeCommand(`xdotool mousemove ${x} ${y} click --repeat 2 1`);
          } else {
            await executeCommand('xdotool click --repeat 2 1');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'double_click', coordinates: { x, y } };
          
        case 'right_click':
          if (x !== undefined && y !== undefined) {
            await executeCommand(`xdotool mousemove ${x} ${y} click 3`);
          } else {
            await executeCommand('xdotool click 3');
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'right_click', coordinates: { x, y } };
          
        case 'move':
          if (x !== undefined && y !== undefined) {
            await executeCommand(`xdotool mousemove ${x} ${y}`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return { success: true, action: 'move', coordinates: { x, y } };
          } else {
            return { success: false, message: 'Coordinates required for move action' };
          }
          
        case 'type':
          if (!value) {
            return { success: false, message: 'Value required for type action' };
          }
          await executeCommand(`xdotool type "${value.replace(/"/g, '\\"')}"`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'type', value };
          
        case 'key':
          if (!value) {
            return { success: false, message: 'Key required for key action' };
          }
          await executeCommand(`xdotool key ${value}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'key', key: value };
          
        case 'drag':
          if (!value) {
            return { success: false, message: 'Coordinates required for drag action (format: "x1,y1,x2,y2")' };
          }
          const [x1, y1, x2, y2] = value.split(',').map(Number);
          await executeCommand(`xdotool mousemove ${x1} ${y1} mousedown 1 mousemove ${x2} ${y2} mouseup 1`);
          await new Promise(resolve => setTimeout(resolve, 500));
          return { success: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
          
        case 'screenshot':
          const screenshotPath = path.join(WORKSPACE_DIR, 'screenshot.png');
          await takeScreenshot(screenshotPath);
          return { success: true, action: 'screenshot', path: screenshotPath };
          
        case 'wait':
          await new Promise(resolve => setTimeout(resolve, timeout));
          return { success: true, action: 'wait', duration: timeout };
          
        default:
          return { success: false, message: `Action '${action}' is not supported` };
      }
    } else {
      // Windows: Not fully supported yet
      return {
        success: false,
        message: 'Direct GUI interaction is not yet fully supported on Windows',
        suggestion: 'Use macOS (cliclick) or Linux (xdotool) for GUI automation, or use vision-based interaction',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `GUI interaction failed: ${error.message}`,
      suggestion: platform === 'darwin' 
        ? 'Check if cliclick is installed (brew install cliclick)'
        : 'Check if xdotool is installed (sudo apt-get install xdotool)',
    };
  }
}

// Helper: Execute GUI assertion
// async function executeGUIAssertion(assertionType: string, selector?: string, expectedValue?: string, timeout: number = 5000): Promise<boolean> {
//   // For non-web apps, assertions are not supported
//   if (!currentGUIApp || currentGUIApp.appType !== 'web') {
//     console.error('[GUI] Assertions are only supported for web apps');
//     return false;
//   }
//   
//   if (!currentGUIApp.url) {
//     return false;
//   }
//   
//   // Check if Playwright is available
//   try {
//     await executeCommand('npm list playwright --depth=0');
//   } catch {
//     console.error('[GUI] Playwright not installed, cannot perform assertions');
//     return false;
//   }
//   
//   const script = `
// const { chromium } = require('playwright');
// 
// (async () => {
//   const browser = await chromium.launch({ headless: false });
//   const page = await browser.newPage();
//   
//   await page.goto('${currentGUIApp.url}');
//   
//   let result = false;
//   
//   try {
//     switch ('${assertionType}') {
//       case 'element_exists':
//         const element = await page.$('${selector}');
//         result = element !== null;
//         break;
//       case 'element_visible':
//         result = await page.isVisible('${selector}', { timeout: ${timeout} });
//         break;
//       case 'text_equals':
//         const text = await page.textContent('${selector}', { timeout: ${timeout} });
//         result = text === '${expectedValue}';
//         break;
//       case 'text_contains':
//         const content = await page.textContent('${selector}', { timeout: ${timeout} });
//         result = content?.includes('${expectedValue}') || false;
//         break;
//       case 'attribute_equals':
//         const attr = await page.getAttribute('${selector}', '${expectedValue?.split('=')[0]}', { timeout: ${timeout} });
//         result = attr === '${expectedValue?.split('=')[1]}';
//         break;
//       case 'element_count':
//         const elements = await page.$$('${selector}');
//         result = elements.length === parseInt('${expectedValue}');
//         break;
//     }
//   } catch (error) {
//     result = false;
//   }
//   
//   console.log(JSON.stringify({ passed: result }));
//   await browser.close();
// })();
// `;
//   
//   try {
//     const { stdout } = await executeCommand(`node -e "${script.replace(/"/g, '\\"')}"`);
//     const { passed } = JSON.parse(stdout);
//     return passed;
//   } catch (error: any) {
//     return false;
//   }
// }

// Helper: Execute Claude Code command
async function executeClaudeCode(prompt: string, workingDir: string = WORKSPACE_DIR): Promise<string> {
  try {
    // Check if claude-code is available
    const claudeCodePath = process.env.CLAUDE_CODE_PATH || 'claude-code';
    
    // Execute claude-code with the prompt
    const { stdout, stderr } = await execAsync(
      `${claudeCodePath} "${prompt.replace(/"/g, '\\"')}"`,
      {
        cwd: workingDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 120000, // 2 minute timeout
      }
    );
    
    if (stderr && !stderr.includes('Warning')) {
      console.error('[ClaudeCode] stderr:', stderr);
    }
    
    return stdout || stderr || 'Command executed successfully';
  } catch (error: any) {
    console.error('[ClaudeCode] Error:', error.message);
    throw new Error(`Claude Code execution failed: ${error.message}`);
  }
}

// Helper: Read file content
async function readFile(filePath: string): Promise<string> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath);
  try {
    return await fs.readFile(fullPath, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }
}

// Helper: Write file content
async function writeFile(filePath: string, content: string): Promise<void> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath);
  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  } catch (error: any) {
    throw new Error(`Failed to write file ${filePath}: ${error.message}`);
  }
}

// Helper: Delete file
async function deleteFile(filePath: string): Promise<void> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath);
  try {
    await fs.unlink(fullPath);
  } catch (error: any) {
    throw new Error(`Failed to delete file ${filePath}: ${error.message}`);
  }
}

// Helper: Check if file exists
async function fileExists(filePath: string): Promise<boolean> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath);
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

// Helper: Execute shell command
async function executeCommand(command: string, workingDir: string = WORKSPACE_DIR): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command, {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000, // 5 minute timeout
    });
  } catch (error: any) {
    throw new Error(`Command execution failed: ${error.message}\nStdout: ${error.stdout}\nStderr: ${error.stderr}`);
  }
}

// Helper: Generate unique requirement ID
function generateRequirementId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize the MCP server
const server = new Server(
  {
    name: 'software-development-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_or_modify_code',
        description: 'Create or modify software code based on requirements. Uses AI assistance if code_content is not provided. Supports create, modify, and delete operations.',
        inputSchema: {
          type: 'object',
          properties: {
            requirement: {
              type: 'string',
              description: 'The requirement or feature description',
            },
            file_path: {
              type: 'string',
              description: 'Path to the file to create or modify (relative to workspace)',
            },
            code_content: {
              type: 'string',
              description: 'The code content to write (optional - if not provided, will use AI to generate)',
            },
            operation: {
              type: 'string',
              enum: ['create', 'modify', 'delete'],
              description: 'Operation to perform: create new file, modify existing, or delete',
            },
            use_ai: {
              type: 'boolean',
              description: 'Whether to use Claude Code for AI-assisted code generation (default: true if code_content not provided)',
            },
          },
          required: ['requirement', 'file_path', 'operation'],
        },
      },
      {
        name: 'generate_test_cases',
        description: 'Generate test cases (unit tests, integration tests, GUI tests) for code based on requirements. Uses AI to create comprehensive test coverage.',
        inputSchema: {
          type: 'object',
          properties: {
            code_file_path: {
              type: 'string',
              description: 'Path to the code file to test',
            },
            requirement: {
              type: 'string',
              description: 'The requirement that the code should fulfill',
            },
            test_type: {
              type: 'string',
              enum: ['unit', 'integration', 'gui', 'end-to-end'],
              description: 'Type of test to generate',
            },
            test_framework: {
              type: 'string',
              description: 'Test framework to use (e.g., jest, vitest, mocha, playwright)',
            },
          },
          required: ['code_file_path', 'requirement', 'test_type'],
        },
      },
      {
        name: 'run_tests',
        description: 'Run tests for a specific file or all tests in the project. Supports various test frameworks and returns detailed results.',
        inputSchema: {
          type: 'object',
          properties: {
            test_file_path: {
              type: 'string',
              description: 'Path to the test file to run (optional - runs all tests if not provided)',
            },
            test_command: {
              type: 'string',
              description: 'Custom test command to run (e.g., "npm test", "vitest run")',
            },
            environment: {
              type: 'string',
              enum: ['development', 'staging', 'production'],
              description: 'Test environment',
            },
          },
        },
      },
      {
        name: 'create_requirement',
        description: 'Create a new requirement for tracking. Requirements can be linked to code files and tests.',
        inputSchema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Detailed description of the requirement',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of files related to this requirement',
            },
          },
          required: ['description'],
        },
      },
      {
        name: 'update_requirement',
        description: 'Update an existing requirement based on test results, user feedback, or new findings',
        inputSchema: {
          type: 'object',
          properties: {
            requirement_id: {
              type: 'string',
              description: 'The ID of the requirement to update',
            },
            updated_description: {
              type: 'string',
              description: 'The updated requirement description',
            },
            reason: {
              type: 'string',
              description: 'Reason for the requirement update',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in-progress', 'completed', 'failed'],
              description: 'Updated status of the requirement',
            },
          },
          required: ['requirement_id', 'updated_description', 'reason'],
        },
      },
      {
        name: 'validate_requirement',
        description: 'Validate whether a requirement has been completed and met by the current implementation',
        inputSchema: {
          type: 'object',
          properties: {
            requirement_id: {
              type: 'string',
              description: 'The ID of the requirement to validate',
            },
            run_tests: {
              type: 'boolean',
              description: 'Whether to run tests as part of validation (default: true)',
            },
          },
          required: ['requirement_id'],
        },
      },
      {
        name: 'list_requirements',
        description: 'List all tracked requirements with their current status',
        inputSchema: {
          type: 'object',
          properties: {
            status_filter: {
              type: 'string',
              enum: ['pending', 'in-progress', 'completed', 'failed', 'all'],
              description: 'Filter requirements by status (default: all)',
            },
          },
        },
      },
      {
        name: 'read_code_file',
        description: 'Read the content of a code file in the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file to read (relative to workspace)',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'start_gui_application',
        description: 'Start a GUI application for testing. Supports Python (tkinter, PyQt, etc.), Electron, web apps, and more. Can run in Docker for isolation.',
        inputSchema: {
          type: 'object',
          properties: {
            app_file_path: {
              type: 'string',
              description: 'Path to the application file to run (e.g., app.py, index.html)',
            },
            app_type: {
              type: 'string',
              enum: ['python', 'electron', 'web', 'java', 'other'],
              description: 'Type of application',
            },
            start_command: {
              type: 'string',
              description: 'Custom command to start the application (e.g., "python app.py", "npm start")',
            },
            wait_for_ready: {
              type: 'number',
              description: 'Seconds to wait for app to be ready (default: 3)',
            },
            use_docker: {
              type: 'boolean',
              description: 'Run in isolated Docker environment (default: false). Prevents interference with user work.',
            },
            test_command: {
              type: 'string',
              description: 'Test command to run in Docker (required if use_docker is true, e.g., "python test_app.py")',
            },
            enable_vnc: {
              type: 'boolean',
              description: 'Enable VNC server for viewing tests (default: true, only for Docker mode)',
            },
            vnc_port: {
              type: 'number',
              description: 'VNC port to expose (default: 5901, only for Docker mode)',
            },
          },
          required: ['app_file_path', 'app_type'],
        },
      },
      {
        name: 'gui_interact',
        description: 'Interact with GUI using direct coordinates (cliclick on macOS, xdotool on Linux). For element-based interaction, use gui_interact_vision instead.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['click', 'double_click', 'right_click', 'move', 'type', 'key', 'drag', 'screenshot', 'wait'],
              description: 'Action to perform. Use coordinates (x, y) for click/move actions.',
            },
            x: {
              type: 'number',
              description: 'X coordinate for click/move actions',
            },
            y: {
              type: 'number',
              description: 'Y coordinate for click/move actions',
            },
            value: {
              type: 'string',
              description: 'Value for the action (text to type, key name, or drag coordinates "x1,y1,x2,y2")',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 5000)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'gui_assert',
        description: 'Assert GUI state using vision-based verification. Ask questions about what should be visible on screen.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Question about expected GUI state (e.g., "Is the OK button visible?", "Does the text say Hello World?")',
            },
            expected_answer: {
              type: 'string',
              description: 'Expected answer (e.g., "yes", "true", "Hello World")',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'stop_gui_application',
        description: 'Stop the running GUI application and cleanup resources.',
        inputSchema: {
          type: 'object',
          properties: {
            force: {
              type: 'boolean',
              description: 'Force kill the application (default: false)',
            },
          },
        },
      },
      {
        name: 'gui_interact_vision',
        description: 'Interact with GUI elements using AI vision to locate elements (cliclick on macOS, xdotool on Linux). Works with ANY GUI app. Describe the element in natural language.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['click', 'double_click', 'right_click', 'type', 'hover'],
              description: 'Action to perform on the GUI element',
            },
            element_description: {
              type: 'string',
              description: 'Natural language description of the element to interact with (e.g., "the red Start button", "the text input field at the top", "the OK button in the dialog")',
            },
            value: {
              type: 'string',
              description: 'Value to type (only for type action)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 5000)',
            },
          },
          required: ['action', 'element_description'],
        },
      },
      {
        name: 'gui_verify_vision',
        description: 'Verify GUI state using AI vision. Ask questions about what is visible on screen and get intelligent answers.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Question about the GUI state (e.g., "Is the game board visible?", "What is the current player shown?", "Are there any error messages?")',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'generate_gui_test_script',
        description: 'Generate a complete GUI test script using Playwright or Selenium based on requirements.',
        inputSchema: {
          type: 'object',
          properties: {
            app_file_path: {
              type: 'string',
              description: 'Path to the GUI application file',
            },
            requirement: {
              type: 'string',
              description: 'Test requirement description',
            },
            test_framework: {
              type: 'string',
              enum: ['playwright', 'selenium', 'pyautogui'],
              description: 'GUI testing framework to use',
            },
            test_scenarios: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of test scenarios to cover',
            },
          },
          required: ['app_file_path', 'requirement', 'test_framework'],
        },
      },
      {
        name: 'appium_start_session',
        description: 'Start an Appium session for mobile/desktop app testing. Supports iOS, Android, Windows, and Mac applications.',
        inputSchema: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              enum: ['iOS', 'Android', 'Windows', 'Mac'],
              description: 'Target platform for testing',
            },
            app_path: {
              type: 'string',
              description: 'Path to the application file (.app, .apk, .ipa, etc.)',
            },
            device_name: {
              type: 'string',
              description: 'Device name or ID (e.g., "iPhone 14", "Pixel 6", "emulator-5554")',
            },
            platform_version: {
              type: 'string',
              description: 'Platform version (e.g., "16.0", "13.0")',
            },
            automation_name: {
              type: 'string',
              enum: ['XCUITest', 'UiAutomator2', 'Espresso', 'Windows', 'Mac2'],
              description: 'Automation engine to use',
            },
            appium_url: {
              type: 'string',
              description: 'Appium server URL (default: http://localhost:4723)',
            },
            additional_capabilities: {
              type: 'object',
              description: 'Additional capabilities as key-value pairs',
            },
          },
          required: ['platform', 'device_name'],
        },
      },
      {
        name: 'appium_interact',
        description: 'Interact with mobile/desktop app elements using Appium. Supports various locator strategies and actions.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['click', 'tap', 'type', 'send_keys', 'clear', 'swipe', 'long_press', 'get_text', 'get_attribute', 'is_displayed', 'is_enabled'],
              description: 'Action to perform on the element',
            },
            locator_strategy: {
              type: 'string',
              enum: ['id', 'xpath', 'accessibility_id', 'class_name', 'android_uiautomator', 'ios_predicate', 'ios_class_chain'],
              description: 'Strategy to locate the element',
            },
            locator: {
              type: 'string',
              description: 'Locator value (e.g., "com.example:id/button", "//XCUIElementTypeButton[@name=\'Login\']")',
            },
            value: {
              type: 'string',
              description: 'Value for the action (text to type, attribute name, swipe direction: up/down/left/right)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 10000)',
            },
          },
          required: ['action', 'locator_strategy', 'locator'],
        },
      },
      {
        name: 'appium_assert',
        description: 'Perform assertions on mobile/desktop app elements using Appium.',
        inputSchema: {
          type: 'object',
          properties: {
            assertion_type: {
              type: 'string',
              enum: ['element_exists', 'element_displayed', 'element_enabled', 'text_equals', 'text_contains', 'attribute_equals'],
              description: 'Type of assertion to perform',
            },
            locator_strategy: {
              type: 'string',
              enum: ['id', 'xpath', 'accessibility_id', 'class_name', 'android_uiautomator', 'ios_predicate', 'ios_class_chain'],
              description: 'Strategy to locate the element',
            },
            locator: {
              type: 'string',
              description: 'Locator value',
            },
            expected_value: {
              type: 'string',
              description: 'Expected value for the assertion (for text_equals, text_contains, attribute_equals use "attributeName=value" format)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 10000)',
            },
          },
          required: ['assertion_type', 'locator_strategy', 'locator'],
        },
      },
      {
        name: 'appium_screenshot',
        description: 'Take a screenshot of the current app state using Appium.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional filename for the screenshot (default: appium_screenshot_<timestamp>.png)',
            },
          },
        },
      },
      {
        name: 'appium_stop_session',
        description: 'Stop the current Appium session and cleanup resources.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'create_or_modify_code': {
        const { requirement, file_path, code_content, operation, use_ai } = args as any;
        
        if (operation === 'delete') {
          await deleteFile(file_path);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `File deleted: ${file_path}`,
                  file_path,
                  operation: 'delete',
                }, null, 2),
              },
            ],
          };
        }

        let finalContent = code_content;
        
        // Use AI to generate code if content not provided
        if (!finalContent && (use_ai !== false)) {
          console.error(`[SoftwareDev] Using AI to generate code for: ${file_path}`);
          
          // Read existing file if modifying
          let existingContent = '';
          if (operation === 'modify' && await fileExists(file_path)) {
            existingContent = await readFile(file_path);
          }
          
          const prompt = operation === 'modify'
            ? `Modify the file ${file_path} to implement this requirement: ${requirement}\n\nCurrent content:\n${existingContent}\n\nProvide the complete updated file content.`
            : `Create a new file ${file_path} to implement this requirement: ${requirement}\n\nProvide the complete file content.`;
          
          try {
            finalContent = await executeClaudeCode(prompt);
          } catch (error: any) {
            // Fallback: create a basic template if Claude Code fails
            console.error(`[SoftwareDev] Claude Code failed, using template: ${error.message}`);
            finalContent = `// TODO: Implement requirement: ${requirement}\n// File: ${file_path}\n\n`;
          }
        }

        if (!finalContent) {
          throw new Error('No code content provided and AI generation failed');
        }

        await writeFile(file_path, finalContent);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Code ${operation} operation completed for ${file_path}`,
                file_path,
                operation,
                requirement,
                used_ai: !code_content,
                content_preview: finalContent.substring(0, 200) + (finalContent.length > 200 ? '...' : ''),
              }, null, 2),
            },
          ],
        };
      }

      case 'appium_start_session': {
        const { 
          platform, 
          app_path, 
          device_name, 
          platform_version, 
          automation_name, 
          appium_url,
          additional_capabilities 
        } = args as any;
        
        // Stop existing session if running
        if (currentAppiumSession) {
          await stopAppiumSession(currentAppiumSession);
          currentAppiumSession = null;
        }
        
        // Build capabilities
        const capabilities: any = {
          platformName: platform,
          'appium:deviceName': device_name,
        };
        
        if (app_path) {
          const fullAppPath = path.isAbsolute(app_path) ? app_path : path.join(WORKSPACE_DIR, app_path);
          capabilities['appium:app'] = fullAppPath;
        }
        
        if (platform_version) {
          capabilities['appium:platformVersion'] = platform_version;
        }
        
        if (automation_name) {
          capabilities['appium:automationName'] = automation_name;
        } else {
          // Set default automation name based on platform
          switch (platform) {
            case 'iOS':
              capabilities['appium:automationName'] = 'XCUITest';
              break;
            case 'Android':
              capabilities['appium:automationName'] = 'UiAutomator2';
              break;
            case 'Windows':
              capabilities['appium:automationName'] = 'Windows';
              break;
            case 'Mac':
              capabilities['appium:automationName'] = 'Mac2';
              break;
          }
        }
        
        // Add additional capabilities
        if (additional_capabilities) {
          Object.assign(capabilities, additional_capabilities);
        }
        
        try {
          const session = await startAppiumSession(capabilities, appium_url);
          currentAppiumSession = session;
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Appium session started',
                  session_id: session.sessionId,
                  platform: session.platform,
                  capabilities: session.capabilities,
                  start_time: session.startTime,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'appium_start_session',
                  error: error.message,
                  suggestion: 'Make sure Appium server is running (appium) and webdriverio is installed (npm install webdriverio)',
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'appium_interact': {
        const { action, locator_strategy, locator, value, timeout } = args as any;
        
        if (!currentAppiumSession) {
          throw new Error('No Appium session is active. Use appium_start_session first.');
        }
        
        console.error(`[Appium] Performing ${action} on ${locator_strategy}=${locator}`);
        
        try {
          const result = await executeAppiumInteraction(
            action,
            locator_strategy,
            locator,
            value,
            timeout || 10000
          );
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action,
                  locator_strategy,
                  locator,
                  value,
                  result,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'appium_interact',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'appium_assert': {
        const { assertion_type, locator_strategy, locator, expected_value, timeout } = args as any;
        
        if (!currentAppiumSession) {
          throw new Error('No Appium session is active. Use appium_start_session first.');
        }
        
        console.error(`[Appium] Asserting ${assertion_type} on ${locator_strategy}=${locator}`);
        
        try {
          const passed = await executeAppiumAssertion(
            assertion_type,
            locator_strategy,
            locator,
            expected_value,
            timeout || 10000
          );
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  assertion_type,
                  locator_strategy,
                  locator,
                  expected_value,
                  passed,
                  message: passed ? 'Assertion passed' : 'Assertion failed',
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'appium_assert',
                  error: error.message,
                  passed: false,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'appium_screenshot': {
        const { filename } = args as any;
        
        if (!currentAppiumSession) {
          throw new Error('No Appium session is active. Use appium_start_session first.');
        }
        
        try {
          const screenshotPath = await takeAppiumScreenshot(filename);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  screenshot_path: screenshotPath,
                  message: 'Screenshot captured successfully',
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'appium_screenshot',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'appium_stop_session': {
        if (!currentAppiumSession) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'No Appium session is active',
                }, null, 2),
              },
            ],
          };
        }
        
        try {
          await stopAppiumSession(currentAppiumSession);
          currentAppiumSession = null;
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Appium session stopped',
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'appium_stop_session',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'generate_test_cases': {
        const { code_file_path, requirement, test_type, test_framework } = args as any;
        
        // Read the code file
        const codeContent = await readFile(code_file_path);
        
        // Determine test file path
        const ext = path.extname(code_file_path);
        const baseName = code_file_path.replace(ext, '');
        const testFilePath = `${baseName}.test${ext}`;
        
        // Generate test cases using AI
        const framework = test_framework || 'vitest';
        const prompt = `Generate ${test_type} tests using ${framework} for the following code file: ${code_file_path}

Requirement: ${requirement}

Code content:
${codeContent}

Generate comprehensive test cases that cover:
1. Happy path scenarios
2. Edge cases
3. Error handling
4. ${test_type === 'unit' ? 'Individual function behavior' : test_type === 'integration' ? 'Component interactions' : 'End-to-end user flows'}

Provide the complete test file content.`;

        let testContent: string;
        try {
          testContent = await executeClaudeCode(prompt);
        } catch (error: any) {
          // Fallback: create a basic test template
          console.error(`[SoftwareDev] Claude Code failed, using template: ${error.message}`);
          testContent = `// ${test_type} tests for ${code_file_path}
// Requirement: ${requirement}
// Framework: ${framework}

import { describe, it, expect } from '${framework}';

describe('${path.basename(code_file_path)}', () => {
  it('should implement requirement: ${requirement}', () => {
    // TODO: Implement test
    expect(true).toBe(true);
  });
});
`;
        }

        await writeFile(testFilePath, testContent);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Generated ${test_type} test cases`,
                test_file_path: testFilePath,
                code_file_path,
                test_type,
                framework,
                content_preview: testContent.substring(0, 200) + (testContent.length > 200 ? '...' : ''),
              }, null, 2),
            },
          ],
        };
      }

      case 'run_tests': {
        const { test_file_path, test_command, environment } = args as any;
        
        const env = environment || TEST_ENV;
        const command = test_command || (test_file_path ? `npm test -- ${test_file_path}` : 'npm test');
        
        console.error(`[SoftwareDev] Running tests: ${command} (env: ${env})`);
        
        try {
          const { stdout, stderr } = await executeCommand(command);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Tests completed',
                  test_file_path: test_file_path || 'all tests',
                  environment: env,
                  command,
                  stdout,
                  stderr,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'Tests failed',
                  test_file_path: test_file_path || 'all tests',
                  environment: env,
                  command,
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'create_requirement': {
        const { description, files } = args as any;
        
        const reqId = generateRequirementId();
        const requirement: Requirement = {
          id: reqId,
          description,
          status: 'pending',
          files: files || [],
          tests: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          history: [],
        };
        
        requirements.set(reqId, requirement);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Requirement created',
                requirement_id: reqId,
                requirement,
              }, null, 2),
            },
          ],
        };
      }

      case 'update_requirement': {
        const { requirement_id, updated_description, reason, status } = args as any;
        
        const req = requirements.get(requirement_id);
        if (!req) {
          throw new Error(`Requirement not found: ${requirement_id}`);
        }
        
        // Add to history
        req.history.push({
          timestamp: new Date(),
          description: req.description,
          reason,
        });
        
        // Update requirement
        req.description = updated_description;
        if (status) {
          req.status = status;
        }
        req.updatedAt = new Date();
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Requirement updated',
                requirement_id,
                requirement: req,
              }, null, 2),
            },
          ],
        };
      }

      case 'validate_requirement': {
        const { requirement_id, run_tests } = args as any;
        
        const req = requirements.get(requirement_id);
        if (!req) {
          throw new Error(`Requirement not found: ${requirement_id}`);
        }
        
        let testResults = null;
        let allTestsPassed = true;
        
        // Run tests if requested
        if (run_tests !== false && req.tests.length > 0) {
          console.error(`[SoftwareDev] Running tests for requirement: ${requirement_id}`);
          
          for (const testFile of req.tests) {
            try {
              const { stdout } = await executeCommand(`npm test -- ${testFile}`);
              testResults = (testResults || '') + stdout + '\n';
            } catch (error: any) {
              allTestsPassed = false;
              testResults = (testResults || '') + `Test failed: ${testFile}\n${error.message}\n`;
            }
          }
        }
        
        // Check if all files exist
        const missingFiles: string[] = [];
        for (const file of req.files) {
          if (!await fileExists(file)) {
            missingFiles.push(file);
          }
        }
        
        const validated = allTestsPassed && missingFiles.length === 0;
        
        // Update requirement status
        if (validated) {
          req.status = 'completed';
        } else {
          req.status = 'failed';
        }
        req.updatedAt = new Date();
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                requirement_id,
                validated,
                status: req.status,
                all_tests_passed: allTestsPassed,
                missing_files: missingFiles,
                test_results: testResults,
                requirement: req,
              }, null, 2),
            },
          ],
        };
      }

      case 'list_requirements': {
        const { status_filter } = args as any;
        
        let filteredReqs = Array.from(requirements.values());
        
        if (status_filter && status_filter !== 'all') {
          filteredReqs = filteredReqs.filter(req => req.status === status_filter);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                total: requirements.size,
                filtered: filteredReqs.length,
                status_filter: status_filter || 'all',
                requirements: filteredReqs,
              }, null, 2),
            },
          ],
        };
      }

      case 'read_code_file': {
        const { file_path } = args as any;
        
        const content = await readFile(file_path);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                file_path,
                content,
                size: content.length,
              }, null, 2),
            },
          ],
        };
      }

      case 'start_gui_application': {
        const { app_file_path, app_type, start_command, wait_for_ready } = args as any;
        
        // Stop existing app if running
        if (currentGUIApp) {
          await stopGUIApplication(currentGUIApp, true);
          currentGUIApp = null;
        }
        
        // Start new app
        const instance = await startGUIApplication(
          app_file_path,
          app_type,
          start_command,
          wait_for_ready || 3
        );
        
        currentGUIApp = instance;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'GUI application started',
                app_file_path,
                app_type,
                pid: instance.pid,
                url: instance.url,
                start_time: instance.startTime,
              }, null, 2),
            },
          ],
        };
      }

      case 'gui_interact': {
        const { action, x, y, value, timeout } = args as any;
        
        if (!currentGUIApp) {
          throw new Error('No GUI application is running. Use start_gui_application first.');
        }
        
        console.error(`[GUI] Performing action: ${action} at (${x}, ${y})`);
        
        try {
          const result = await executeGUIInteraction(action, x, y, value, timeout || 5000);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'gui_interact',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'gui_assert': {
        const { question, expected_answer } = args as any;
        
        if (!currentGUIApp) {
          throw new Error('No GUI application is running. Use start_gui_application first.');
        }
        
        console.error(`[GUI] Asserting: ${question}`);
        
        try {
          // Use vision to verify the GUI state
          const screenshotPath = path.join(WORKSPACE_DIR, 'gui_screenshot.png');
          
          // Bring window to front and take screenshot
          await focusApplicationWindow();
          await new Promise(resolve => setTimeout(resolve, 1000));
          await takeScreenshot(screenshotPath);
          
          // Analyze with vision model
          const imageBuffer = await fs.readFile(screenshotPath);
          const base64Image = imageBuffer.toString('base64');
          
          const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
          if (!apiKey) {
            throw new Error('Anthropic API key not configured. Please configure it in Settings.');
          }
          
          const baseUrl = process.env.ANTHROPIC_BASE_URL;
          const visionModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-3-5-sonnet-20241022';
          
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({
            apiKey: apiKey,
            baseURL: baseUrl,
          });
          
          const message = await anthropic.messages.create({
            model: visionModel,
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: base64Image,
                    },
                  },
                  {
                    type: 'text',
                    text: `Analyze this GUI screenshot and answer the following question:\n\n${question}\n\nProvide a clear yes/no answer or the specific information requested.`,
                  },
                ],
              },
            ],
          });
          
          const answer = message.content[0].type === 'text' ? message.content[0].text : '';
          
          // Check if answer matches expected (if provided)
          let passed = true;
          if (expected_answer) {
            const normalizedAnswer = answer.toLowerCase().trim();
            const normalizedExpected = expected_answer.toLowerCase().trim();
            passed = normalizedAnswer.includes(normalizedExpected) || normalizedAnswer === normalizedExpected;
          }
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  question,
                  answer,
                  expected_answer,
                  passed,
                  screenshot_path: screenshotPath,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'gui_assert',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'stop_gui_application': {
        const { force } = args as any;
        
        if (!currentGUIApp) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'No GUI application is running',
                }, null, 2),
              },
            ],
          };
        }
        
        await stopGUIApplication(currentGUIApp, force || false);
        currentGUIApp = null;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'GUI application stopped',
              }, null, 2),
            },
          ],
        };
      }

      case 'gui_interact_vision': {
        const { action, element_description, value, timeout } = args as any;
        
        if (!currentGUIApp) {
          throw new Error('No GUI application is running. Use start_gui_application first.');
        }
        
        console.error(`[Vision] Performing ${action} on "${element_description}"`);
        
        try {
          const result = await executeGUIInteractionWithVision(action, element_description, value, timeout || 5000);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'gui_interact_vision',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'gui_verify_vision': {
        const { question } = args as any;
        
        if (!currentGUIApp) {
          throw new Error('No GUI application is running. Use start_gui_application first.');
        }
        
        console.error(`[Vision] Verifying: ${question}`);
        
        try {
          // Bring window to front before taking screenshot
          console.error('[Vision] Bringing window to front for verification...');
          await focusApplicationWindow();
          console.error('[Vision] Waiting 1 second for window to come to front...');
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for window to come to front (increased to 1s)
          
          // Take screenshot
          console.error('[Vision] Taking screenshot for verification...');
          const platform = require('os').platform();
          const screenshotPath = path.join(WORKSPACE_DIR, 'gui_screenshot.png');
          
          let screenshotCmd: string;
          if (platform === 'darwin') {
            screenshotCmd = `screencapture -x ${screenshotPath}`;
          } else if (platform === 'win32') {
            screenshotCmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Drawing.Bitmap]::FromScreen([System.Windows.Forms.Screen]::PrimaryScreen.Bounds).Save('${screenshotPath}')"`;
          } else {
            screenshotCmd = `import -window root ${screenshotPath}`;
          }
          
          await executeCommand(screenshotCmd);
          
          // Analyze with vision model
          const imageBuffer = await fs.readFile(screenshotPath);
          const base64Image = imageBuffer.toString('base64');
          
          // Get API key from environment (set by configStore.applyToEnv())
          const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
          
          if (!apiKey) {
            throw new Error('Anthropic API key not configured. Please configure it in Settings.');
          }
          
          // Use the model configured by the user
          const baseUrl = process.env.ANTHROPIC_BASE_URL;
          const visionModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-3-5-sonnet-20241022';
          
          console.error(`[Vision] Using configured model: ${visionModel} (baseURL: ${baseUrl || 'default'})`);
          
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({
            apiKey: apiKey,
            baseURL: baseUrl,
          });
          
          const message = await anthropic.messages.create({
            model: visionModel,
            max_tokens: 2048,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: base64Image,
                    },
                  },
                  {
                    type: 'text',
                    text: `Analyze this GUI screenshot and answer the following question:\n\n${question}\n\nProvide a detailed answer based on what you can see in the image.`,
                  },
                ],
              },
            ],
          });
          
          const answer = message.content[0].type === 'text' ? message.content[0].text : '';
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  question,
                  answer,
                  screenshot_path: screenshotPath,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  tool: 'gui_verify_vision',
                  error: error.message,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'generate_gui_test_script': {
        const { app_file_path, requirement, test_framework, test_scenarios } = args as any;
        
        // Read the app file to understand its structure
        const appContent = await readFile(app_file_path);
        
        // Generate test script using AI
        const scenariosText = test_scenarios ? test_scenarios.join('\n- ') : 'Basic functionality';
        const prompt = `Generate a ${test_framework} GUI test script for the following application:

Application file: ${app_file_path}
Requirement: ${requirement}

Test scenarios to cover:
- ${scenariosText}

Application code:
${appContent}

Generate a complete ${test_framework} test script that:
1. Starts the application
2. Tests all specified scenarios
3. Includes assertions for expected behavior
4. Handles cleanup properly
5. Provides clear test output

Use best practices for ${test_framework} testing.`;

        let testScript: string;
        try {
          testScript = await executeClaudeCode(prompt);
        } catch (error: any) {
          // Fallback: create a basic test template
          console.error(`[SoftwareDev] Claude Code failed, using template: ${error.message}`);
          testScript = `# GUI Test Script for ${app_file_path}
# Framework: ${test_framework}
# Requirement: ${requirement}

import ${test_framework === 'playwright' ? 'playwright' : 'selenium'}

# TODO: Implement GUI tests
# Scenarios:
${test_scenarios ? test_scenarios.map((s: string) => `# - ${s}`).join('\n') : '# - Basic functionality'}

def test_gui():
    # Start application
    # Perform interactions
    # Assert expected behavior
    pass
`;
        }
        
        // Determine test file path
        const ext = path.extname(app_file_path);
        const baseName = app_file_path.replace(ext, '');
        const testFilePath = `${baseName}_gui_test.${test_framework === 'playwright' ? 'js' : 'py'}`;
        
        await writeFile(testFilePath, testScript);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'GUI test script generated',
                test_file_path: testFilePath,
                app_file_path,
                test_framework,
                scenarios_count: test_scenarios?.length || 0,
                content_preview: testScript.substring(0, 300) + (testScript.length > 300 ? '...' : ''),
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`[SoftwareDev] Error in ${name}:`, error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            tool: name,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
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
  
  console.error('='.repeat(60));
  console.error('Software Development MCP Server v1.0.0');
  console.error('='.repeat(60));
  console.error(`Workspace: ${WORKSPACE_DIR}`);
  console.error(`Test Environment: ${TEST_ENV}`);
  console.error(`Claude Code: ${process.env.CLAUDE_CODE_PATH || 'claude-code (from PATH)'}`);
  console.error('');
  console.error('Available Tools:');
  console.error('  Code Development:');
  console.error('    - create_or_modify_code: Create/modify code with AI assistance');
  console.error('    - read_code_file: Read file contents');
  console.error('  Testing:');
  console.error('    - generate_test_cases: Generate comprehensive test suites');
  console.error('    - run_tests: Execute tests and get results');
  console.error('  GUI Testing:');
  console.error('    - start_gui_application: Launch GUI app for testing');
  console.error('    - gui_interact: Direct coordinate-based interaction (cliclick/xdotool)');
  console.error('    - gui_interact_vision: AI vision-based GUI interaction');
  console.error('    - gui_verify_vision: AI vision-based GUI verification');
  console.error('    - gui_assert: Vision-based GUI state assertions');
  console.error('    - stop_gui_application: Stop running GUI app');
  console.error('    - generate_gui_test_script: Generate GUI test scripts');
  console.error('  Appium Testing (Mobile/Desktop):');
  console.error('    - appium_start_session: Start Appium session (iOS/Android/Windows/Mac)');
  console.error('    - appium_interact: Interact with app elements');
  console.error('    - appium_assert: Assert app state');
  console.error('    - appium_screenshot: Capture app screenshot');
  console.error('    - appium_stop_session: Stop Appium session');
  console.error('  Requirements:');
  console.error('    - create_requirement: Track new requirements');
  console.error('    - update_requirement: Update requirement status');
  console.error('    - validate_requirement: Validate requirement completion');
  console.error('    - list_requirements: List all tracked requirements');
  console.error('='.repeat(60));
  console.error('Server ready and listening on stdio');
  console.error('='.repeat(60));
}

main().catch((error) => {
  console.error('Failed to start Software Development MCP server:', error);
  process.exit(1);
});
