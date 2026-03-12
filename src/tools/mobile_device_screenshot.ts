/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const execFileAsync = promisify(execFile);

const HDC_DEVICE_PATH = '/data/local/tmp/0.jpeg';

export const takeMobileDeviceScreenshot = defineTool({
  name: 'take_mobile_device_screenshot',
  description: `Take a screenshot from a connected mobile device using HDC (Device Connector).`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.',
      ),
  },
  handler: async (request, response, context) => {
    let tempFilePath: string | undefined;

    try {
      await execFileAsync('hdc', [
        'shell',
        'snapshot_display',
        '-f',
        HDC_DEVICE_PATH,
      ]);

      tempFilePath = path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-screenshot-')),
        'screenshot.jpeg',
      );

      await execFileAsync('hdc', [
        'file',
        'recv',
        HDC_DEVICE_PATH,
        tempFilePath,
      ]);

      const screenshotData = await fs.readFile(tempFilePath);

      response.appendResponseLine('Took a screenshot from the mobile device.');

      if (request.params.filePath) {
        const file = await context.saveFile(
          screenshotData,
          request.params.filePath,
        );
        response.appendResponseLine(`Saved screenshot to ${file.filename}.`);
      } else if (screenshotData.length >= 2_000_000) {
        const {filename} = await context.saveTemporaryFile(
          screenshotData,
          'image/jpeg',
        );
        response.appendResponseLine(`Saved screenshot to ${filename}.`);
      } else {
        response.attachImage({
          mimeType: 'image/jpeg',
          data: screenshotData.toString('base64'),
        });
      }
    } catch (err) {
      const error = err as Error;
      throw new Error(
        `Failed to take mobile device screenshot: ${error.message}`,
      );
    } finally {
      if (tempFilePath) {
        await fs.rm(path.dirname(tempFilePath), {recursive: true, force: true});
      }
    }
  },
});
