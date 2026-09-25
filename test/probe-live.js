(() => {
  const q = (s) => document.querySelector(s);
  const input = q('.exc-input') || q('input[type=text]');
  const btn = q('.btn-exchange') ||
    Array.from(document.querySelectorAll('button,a,div')).find((el) => /đổi|redeem|exchange/i.test((el.textContent || '').trim()) && el.offsetParent);
  const text = (document.body.innerText || '').slice(0, 600);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    hasInput: !!input,
    inputSelector: input ? (input.className || input.tagName) : null,
    inputPlaceholder: input ? input.placeholder : null,
    hasButton: !!btn,
    buttonText: btn ? (btn.textContent || '').trim().slice(0, 40) : null,
    buttonClass: btn ? btn.className : null,
    loggedInHints: {
      hasLoginWord: /đăng nhập|log ?in|sign ?in/i.test(text),
      hasLogoutWord: /đăng xuất|log ?out/i.test(text),
      roleIdFields: Array.from(document.querySelectorAll('input')).map((i) => i.className || i.name || i.type).slice(0, 8),
    },
    bodyPreview: text,
  }, null, 1);
})()
