/**
 * ============================================================
 *  拾光集 · 主界面卡片顺序（第五十四轮）(huborder.js)
 * ------------------------------------------------------------
 *  主界面卡片允许用户**长按拖动换位置**，顺序存在 `settings.hubOrder`（id 数组）。
 *
 *  为什么存渲染层设置、不改进插件清单的 order：
 *    · `plugins.js` 的 `order` 是**出厂默认顺序**，它决定「新装/新开的模块摆哪」；
 *    · 用户拖出来的是**个人偏好**，跟插件本身没关系 —— 把两者混在一个字段里，
 *      以后调整出厂顺序就会把所有人的习惯冲掉。
 *
 *  🔴 这份逻辑必须容忍三种脏数据（都会真实发生）：
 *    ① 存档里有 id，但那个插件**已经被关掉/删掉** → 忽略它
 *    ② 插件清单里有 id，存档里**没有**（新装的插件）→ 追加在末尾，保持相对顺序
 *    ③ 存档里同一个 id 出现两次 → 只认第一次
 *  任何一条没兜住，主界面就会「少一张卡」或「顺序乱跳」。
 *
 *  纯函数、无 DOM、无 window 依赖（除了末尾挂载）—— `tools/huborder-test.js` 直接 require。
 * ============================================================ */
(function () {
  'use strict';

  const HubOrder = {
    /**
     * 按用户存的顺序排一遍。
     * @param {Array} list   插件清单（只要有 id 字段，顺序 = 出厂顺序）
     * @param {Array} order  用户存的 id 数组（可能是空 / 脏的）
     * @returns {Array}      新数组（不改原数组）
     */
    apply(list, order) {
      const arr = Array.isArray(list) ? list : [];
      const ord = Array.isArray(order) ? order : [];
      if (!arr.length) return [];
      if (!ord.length) return arr.slice();

      /* 同一个 id 只认第一次出现的位置（脏存档兜底 ③） */
      const rank = new Map();
      ord.forEach((id, i) => {
        const k = String(id == null ? '' : id);
        if (k && !rank.has(k)) rank.set(k, i);
      });

      const known = [];
      const rest = [];
      arr.forEach((item, i) => {
        const k = String((item && item.id) == null ? '' : item.id);
        if (rank.has(k)) known.push({ item, i, r: rank.get(k) });
        else rest.push({ item, i });                       // 兜底 ②：没登记过的排后面
      });

      /* rank 相同的（理论上不会有）用出厂下标兜底，保证结果稳定 */
      known.sort((a, b) => (a.r - b.r) || (a.i - b.i));
      return known.concat(rest).map((x) => x.item);
    },

    /** 从一份清单里取 id（拖动结束后写回存档用） */
    ids(list) {
      return (Array.isArray(list) ? list : [])
        .map((x) => String((x && x.id) == null ? '' : x.id))
        .filter(Boolean);
    },

    /**
     * 把 DOM 上真实的卡片顺序读成 id 数组。
     * ⚠️ 拖动结束后**只信 DOM**：用户看到的就是它，拿内存里那份算等于把用户的操作丢掉。
     */
    fromNodes(nodes) {
      return (Array.isArray(nodes) ? nodes : [])
        .map((n) => (n && n.dataset ? String(n.dataset.mid || '') : ''))
        .filter(Boolean);
    }
  };

  window.HubOrder = HubOrder;
})();
