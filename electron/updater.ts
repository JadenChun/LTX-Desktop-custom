import { autoUpdater, UpdateDownloadedEvent } from 'electron-updater';
import { logger } from './logger';
import { preDownloadPythonForUpdate } from './python-setup';
import { getMainWindow } from './window';

export type UpdateChannel = 'latest' | 'beta' | 'alpha'

export function initAutoUpdater(
  channel: UpdateChannel = 'latest'
): void {
  if (process.platform === 'win32') {
    logger.info('[updater] Windows offline package detected, skipping auto-updater')
    return
  }

  if (channel !== 'latest') {
    autoUpdater.channel = channel
    autoUpdater.allowPrerelease = true
  }

  // Bundled-runtime builds don't need a separate python pre-download.
  autoUpdater.on('update-downloaded', async (info: UpdateDownloadedEvent) => {
    if (process.platform === 'darwin') return

    const newVersion = info.version
    logger.info( `[updater] Update downloaded: v${newVersion}, bundled runtime requires no pre-download`)

    try {
      const didDownload = await preDownloadPythonForUpdate(newVersion, (progress) => {
        getMainWindow()?.webContents.send('python-update-progress', progress)
      })
      logger.info( didDownload
        ? '[updater] Python pre-download complete'
        : '[updater] No python changes needed')
    } catch (err) {
      logger.error( `[updater] Python pre-download failed: ${err}`)
    }
  })

  const update = () => {
    logger.info( 'Checking for update...');
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      logger.error( `Failed checking for updates: ${e}`);
    });
  }

  // Check after startup, then periodically
  setTimeout(update, 5_000);
  setInterval(update, 4 * 60 * 60 * 1000);
}
