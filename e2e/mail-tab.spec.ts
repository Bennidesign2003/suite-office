import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

test.describe('mail', () => {
  test('the Mail card opens one mailbox tab with the account setup', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'mail-tab' })
    const { app, page } = launched
    try {
      const card = page.locator('.quick-card', { hasText: 'Mail' })
      await card.click()
      const mailTab = page.locator('.tab-bar .tab-item:not(.tab-home)')
      await expect(mailTab).toHaveCount(1)
      await expect(mailTab).toContainText('Mail')

      const mailPage = await waitForPageWithUrl(app, '://mail/')
      await expect(mailPage.locator('.welcome-card')).toBeVisible()
      await mailPage.locator('.welcome-card .btn-primary').click()
      await mailPage.locator('input[type=email]').fill('someone@gmail.com')
      await mailPage.getByText('Server settings').click()
      // the provider preset fills in the servers
      await expect(mailPage.locator('.acc-server .acc-host input').first()).toHaveValue(
        'imap.gmail.com',
      )
      await mailPage.screenshot({ path: screenshotPath('mail-account-setup') })

      // a second click on the card brings the same tab forward
      await page.locator('.tab-bar .tab-home').click()
      await card.click()
      await expect(page.locator('.tab-bar .tab-item:not(.tab-home)')).toHaveCount(1)
    } finally {
      await closeAndSaveVideo(launched, 'mail-tab')
    }
  })
})
