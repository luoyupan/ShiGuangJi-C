/* 示例插件界面：由 dll 里的 UI_JS 资源提供，宿主当普通脚本加载 */
(function () {
  SGJPlugin.define({
    id: 'hello',
    apiVersion: 1,
    mount(container, api) {
      const { el } = window.util;
      const wrap = el('div', { class: 'hello-plugin' });
      wrap.appendChild(el('h3', { style: { margin: '0 0 8px' }, text: '这是一个独立的 dll 插件' }));
      wrap.appendChild(el('p', { class: 'sub', text: '清单、界面、后端全部在 modules/hello.dll 里。加一个 dll，主界面就多一张卡。' }));
      const out = el('div', { class: 'hello-out', text: '点下面的按钮，调 dll 里的 C 函数。' });
      const name = el('input', { class: 'hello-input', placeholder: '你的名字', value: '小明' });
      const btn = el('button', {
        class: 'btn btn-primary', onclick: async () => {
          try {
            const r = await api.call('greet', name.value || '朋友');
            out.textContent = r.msg + '（' + r.engine + ' / ABI ' + r.abi + '）';
            api.toast('dll 调用成功', 'ok');
          } catch (e) { out.textContent = '调用失败：' + e.message; }
        }, text: '问个好吧'
      });
      wrap.appendChild(el('div', { class: 'hello-row' }, name, btn));
      wrap.appendChild(out);
      container.appendChild(wrap);
      return () => {};
    }
  });
})();
