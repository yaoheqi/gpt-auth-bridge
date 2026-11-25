const TEAM_CHECKOUT_REGIONS = [
  { country: 'EG', name: '埃及', currency: 'EGP' },
  { country: 'US', name: '美国', currency: 'USD' },
  { country: 'SE', name: '瑞典', currency: 'SEK' },
  { country: 'PH', name: '菲律宾', currency: 'PHP' },
  { country: 'TH', name: '泰国', currency: 'THB' },
  { country: 'GB', name: '英国', currency: 'GBP' },
  { country: 'CA', name: '加拿大', currency: 'CAD' },
  { country: 'ZA', name: '南非', currency: 'ZAR' },
  { country: 'AU', name: '澳大利亚', currency: 'AUD' },
  { country: 'JP', name: '日本', currency: 'JPY' },
  { country: 'SG', name: '新加坡', currency: 'SGD' },
  { country: 'DE', name: '德国', currency: 'EUR' },
];

export function initializeTeamCheckout({ request = fetch, isWorkspaceCurrent = () => () => true } = {}) {
  const form = document.querySelector('#team-checkout-form');
  const fields = document.querySelector('#team-checkout-fields');
  const button = document.querySelector('#generate-team-checkout');
  const token = document.querySelector('#team-access-token');
  const status = document.querySelector('#team-checkout-status');
  const result = document.querySelector('.team-checkout-result');
  const output = document.querySelector('#team-checkout-output');
  const urlField = document.querySelector('#team-checkout-url');
  const openLink = document.querySelector('#open-team-checkout');
  const countryInput = document.querySelector('#team-country');
  const currencyInput = document.querySelector('#team-currency');
  const proxyInput = document.querySelector('#team-proxy-url');
  const regionButtons = [];
  let controller;
  let popup;

  function refresh({ countryChanged = false } = {}) {
    const region = TEAM_CHECKOUT_REGIONS.find(item => item.country === countryInput.value) || TEAM_CHECKOUT_REGIONS[0];
    const automatic = countryInput.value === 'auto';
    currencyInput.disabled = automatic;
    if (countryChanged) currencyInput.value = automatic ? '' : region.currency;
    const proxyMode = document.querySelector('input[name="proxyMode"]:checked')?.value || 'builtin';
    const custom = proxyMode === 'custom';
    proxyInput.disabled = !custom;
    proxyInput.required = custom;
    document.querySelector('.team-proxy-field').classList.toggle('hidden', !custom);
    document.querySelector('#team-config-proxy').textContent = { builtin: '内置代理', custom: '自定义代理', direct: '服务器直连' }[proxyMode];
    document.querySelector('#team-config-country').textContent = automatic ? '自动识别' : region.name + '（' + region.country + '）';
    document.querySelector('#team-config-seats').textContent = document.querySelector('#team-seat-quantity').value || '2';
    document.querySelector('#team-config-currency').textContent = automatic ? '随地区确定' : currencyInput.value || region.currency;
    document.querySelector('#team-config-interval').textContent = document.querySelector('#team-price-interval').value === 'year' ? '年付订阅' : '月付订阅';
    document.querySelector('#team-config-workspace').textContent = document.querySelector('#team-existing-workspace').value.trim() ? '已有空间' : '新建空间';
    for (const regionButton of regionButtons) regionButton.setAttribute('aria-pressed', String(regionButton.dataset.teamCountry === countryInput.value));
  }

  for (const region of TEAM_CHECKOUT_REGIONS) {
    const row = document.createElement('tr');
    const countryCell = document.createElement('td');
    const currencyCell = document.createElement('td');
    const regionButton = document.createElement('button');
    regionButton.type = 'button';
    regionButton.dataset.teamCountry = region.country;
    regionButton.textContent = region.name + '（' + region.country + '）';
    regionButton.addEventListener('click', () => {
      if (controller) return;
      countryInput.value = region.country;
      countryInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    currencyCell.textContent = region.currency;
    countryCell.append(regionButton);
    row.append(countryCell, currencyCell);
    document.querySelector('#team-region-list').append(row);
    regionButtons.push(regionButton);
  }

  function setBusy(busy) {
    fields.disabled = busy;
    for (const regionButton of regionButtons) regionButton.disabled = busy;
    result.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? '正在生成…' : '生成长链接';
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function clearResult() {
    output.hidden = true;
    urlField.value = '';
    openLink.removeAttribute('href');
    document.querySelector('#team-checkout-summary').textContent = '';
    document.querySelector('#team-checkout-session').textContent = '';
  }

  function reset() {
    controller?.abort();
    controller = null;
    popup?.close();
    popup = null;
    token.value = '';
    clearResult();
    setBusy(false);
    refresh();
    showStatus('填写团队配置后，点击“生成长链接”。');
  }

  form.addEventListener('input', () => {
    if (!controller) {
      clearResult();
      showStatus('填写团队配置后，点击“生成长链接”。');
      refresh();
    }
  });
  form.addEventListener('change', event => {
    if (controller) return;
    clearResult();
    showStatus('填写团队配置后，点击“生成长链接”。');
    refresh({ countryChanged: event.target === countryInput });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (controller || !form.reportValidity()) return;
    const isCurrent = isWorkspaceCurrent();
    if (!isCurrent()) return;
    const values = Object.fromEntries(new FormData(form));
    if (values.proxyMode !== 'custom') delete values.proxyUrl;
    values.seatQuantity = Number(values.seatQuantity);
    const autoOpen = document.querySelector('#team-auto-open').checked;
    clearResult();
    controller = new AbortController();
    const activeController = controller;
    if (autoOpen) {
      popup = window.open('about:blank', '_blank');
      if (popup) {
        popup.opener = null;
        popup.document.title = '正在生成 Team 支付链接';
        popup.document.body.textContent = '正在生成 Team 支付链接，请稍候…';
      }
    }
    setBusy(true);
    showStatus('正在请求支付长链接，请稍候…');
    try {
      const response = await request('/api/v2/team/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values), signal: activeController.signal,
      });
      const data = await response.json();
      if (!isCurrent() || activeController.signal.aborted) return;
      if (!response.ok || !data.ok) throw new Error(typeof data.error === 'string' ? data.error : '生成链接失败，请稍后重试');
      const checkoutUrl = new URL(data.url);
      if (checkoutUrl.protocol !== 'https:' || !['checkout.stripe.com', 'pay.openai.com', 'chatgpt.com'].includes(checkoutUrl.hostname) || checkoutUrl.username || checkoutUrl.password || checkoutUrl.port) {
        throw new Error('服务端返回了无效的支付链接');
      }
      urlField.value = checkoutUrl.href;
      openLink.href = checkoutUrl.href;
      document.querySelector('#team-checkout-summary').textContent = [data.workspaceName, data.seatQuantity + ' 个席位', data.priceInterval === 'year' ? '年付' : '月付', data.country + ' / ' + data.currency].join(' · ');
      document.querySelector('#team-checkout-session').textContent = data.checkoutSessionId ? 'Session ID：' + data.checkoutSessionId : '';
      output.hidden = false;
      token.value = '';
      showStatus('Team 支付长链接已生成。');
      if (popup && !popup.closed) {
        popup.location.replace(checkoutUrl.href);
        popup = null;
      } else if (autoOpen) {
        showStatus('链接已生成；自动打开被浏览器阻止，请点击“打开支付页面”。');
      }
    } catch (error) {
      if (controller === activeController) {
        popup?.close();
        popup = null;
      }
      if (isCurrent() && !activeController.signal.aborted) showStatus(error instanceof SyntaxError ? '服务返回了无效响应，请稍后重试' : error.message || '网络异常，请稍后重试', true);
    } finally {
      if (controller === activeController) {
        popup?.close();
        popup = null;
        controller = null;
        setBusy(false);
      }
    }
  });

  document.querySelector('#copy-team-checkout').addEventListener('click', async () => {
    if (!urlField.value) return;
    try {
      await navigator.clipboard.writeText(urlField.value);
      showStatus('支付长链接已复制。');
    } catch {
      urlField.focus();
      urlField.select();
      showStatus('自动复制不可用，已选中链接，请手动复制。');
    }
  });
  refresh();
  return { reset, refresh };
}
