'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const workspace = path.resolve(
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '../../.local/dbgate-e2e')
);

function readNdjsonLogs(directory) {
  if (!fs.existsSync(directory)) return '';
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readNdjsonLogs(fullPath);
    return entry.isFile() && entry.name.endsWith('.ndjson') ? fs.readFileSync(fullPath, 'utf8') : '';
  }).join('\n');
}

async function saveInlineFixture(request, accessToken) {
  const response = await request.post('/connections/save', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    data: {
      displayName: 'Relay fixture',
      engine: 'relay-mysql@dbgate-plugin-relay-mysql',
      isReadOnly: true,
      useInlineProfile: true,
      relayCommand: '/synthetic/relay-cli',
      relayArgs: ['login', '-u', 'fixture-reader'],
      relayPrompt: 'RELAY> \\$',
      relayPasswordPrompt: '(?i)password:',
      relayPasswordEnv: 'E2E_RELAY_PASSWORD',
      sshTarget: 'reader@example.invalid',
      sshPrompt: 'REMOTE> \\$',
      sshPasswordPrompt: '(?i)password:',
      sshPasswordEnv: 'E2E_SSH_PASSWORD',
      mysqlCommand: 'mysql',
      mysqlHost: '127.0.0.1',
      mysqlPort: 3306,
      mysqlUserEnv: 'E2E_MYSQL_USER',
      mysqlPasswordEnv: 'E2E_MYSQL_PASSWORD',
      runnerPath: path.resolve(__dirname, '../fixtures/fake-runner.js'),
      timeoutMs: 5000,
      unsaved: false,
    },
  });
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved._id).toBeTruthy();
  return saved;
}

test('DbGate manages an inline relay profile and renders query results', async ({ page, request }) => {
  await page.goto('/');

  const addConnection = page.getByTestId('ConnectionList_buttonNewConnection');
  await expect(addConnection).toBeVisible();
  await addConnection.click();
  const connectionTab = page.locator('[data-testid^="TabContent_"].tabVisible').last();
  await connectionTab
    .getByTestId('ConnectionDriverFields_connectionType')
    .selectOption('relay-mysql@dbgate-plugin-relay-mysql');
  await connectionTab.getByTestId('ConnectionTab_tabAdvanced').click();

  const profileToggleRow = connectionTab
    .locator('.largeFormMarker')
    .filter({ hasText: 'Manage Relay, SSH and MySQL settings in this connection' });
  const profileToggle = profileToggleRow.locator('input[type="checkbox"]');
  await expect(profileToggle).not.toBeChecked();
  await profileToggle.check();

  const relayCommand = connectionTab
    .locator('.largeFormMarker')
    .filter({ hasText: 'Relay · command' })
    .locator('input');
  const localProfileName = connectionTab
    .locator('.largeFormMarker')
    .filter({ hasText: 'Local profile name' })
    .locator('input');
  await expect(relayCommand).toBeEnabled();
  await expect(localProfileName).toBeDisabled();
  await expect(connectionTab.getByTestId('ConnectionTab_buttonConnect')).toBeEnabled();

  const accessToken = await page.evaluate(() => localStorage.getItem('accessToken'));
  expect(accessToken).toBeTruthy();
  await saveInlineFixture(request, accessToken);

  // DbGate renders the connection and its databases as generic draggable
  // rows. Target the row inside the stable connection-list container; the
  // text-only locator can race the initial unauthenticated API retry.
  const connectionList = page.getByTestId('ConnectionList_container');
  const fixtureConnectionRow = connectionList
    .locator('.main')
    .filter({ hasText: 'Relay fixture' })
    .last();
  await fixtureConnectionRow.dblclick();
  await expect(fixtureConnectionRow.locator('.expand-icon')).toBeVisible();
  await fixtureConnectionRow.locator('.expand-icon').click();
  await connectionList.locator('.main').filter({ hasText: 'fixture_db' }).click();

  const tree = page.getByTestId('SqlObjectList_container');
  const tableRow = tree
    .getByTestId('app-object-group-items-tables')
    .locator(':scope > .main')
    .filter({ hasText: 'wide_table' });
  await expect(tableRow).toBeVisible({ timeout: 15_000 });
  await tableRow.locator('.expand-icon').click();
  const fields = tableRow.locator('xpath=following-sibling::div[contains(@class, "subitems")][1]');
  await expect(fields.locator(':scope > .main').filter({ hasText: /^\s*id\s+bigint\s*$/ })).toBeVisible();
  await expect(fields.locator(':scope > .main').filter({ hasText: /^\s*name\s+varchar/ })).toBeVisible();

  const pageRequest = page.waitForRequest(request => {
    if (!request.url().endsWith('/database-connections/sql-select')) return false;
    if (request.method() !== 'POST') return false;
    const body = request.postDataJSON();
    return body?.select?.from?.name?.pureName === 'wide_table' && body?.select?.range?.offset === 0;
  });

  await tableRow.click();
  const tableDataRequest = await pageRequest;
  expect(tableDataRequest.postDataJSON().select.range).toEqual({ offset: 0, limit: 100 });

  await expect(page.getByText('fixture-row-1', { exact: true })).toBeVisible();

  const grid = page.locator('.tableScrollContainer:visible').last();
  await expect.poll(() => grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);

  const resizableHeader = grid.locator('td.header-cell[data-row="header"][data-col="1"]');
  const resizeHandle = resizableHeader.locator('.resizeHandleControl');
  const widthBefore = await resizableHeader.evaluate(element => element.getBoundingClientRect().width);
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  // The DbGate handle itself is zero-width; its ::before hit target extends
  // three pixels to the left and right.
  await page.mouse.move(handleBox.x - 1, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 47, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => resizableHeader.evaluate(element => element.getBoundingClientRect().width))
    .toBeGreaterThan(widthBefore + 30);

  const gridBox = await grid.boundingBox();
  expect(gridBox).not.toBeNull();
  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
  await page.mouse.wheel(3_000, 0);
  await expect.poll(() => grid.evaluate(element => element.scrollLeft > 0)).toBe(true);
  await expect(grid.locator('td').filter({ hasText: 'right-edge-value' })).toBeVisible();

  await page.getByTestId('TabsPanel_buttonNewObject').click();
  await page.getByTestId('NewObjectModal_query').click();
  await page.locator('.ace_editor:visible').click();
  const manualMarker = `privacy_probe_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await page.keyboard.insertText(`SELECT 1 AS ${manualMarker}`);
  await page.getByTestId('QueryTab_executeButton').click();
  await expect(page.getByText(manualMarker, { exact: true })).toBeVisible();
  await expect(page.getByText('1', { exact: true }).last()).toBeVisible();

  // File logging is asynchronous; let any accidental write become observable
  // before checking the workspace recursively.
  await page.waitForTimeout(500);
  const logs = readNdjsonLogs(workspace);
  expect(logs).not.toContain(manualMarker);
  expect(logs).not.toContain('fixture-row-1');
  expect(logs).not.toContain('right-edge-value');
});
