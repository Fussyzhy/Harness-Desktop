/**
 * Harness Desktop's plugin manager — browser half.
 *
 * Hand-written in dsh's lazy-CJS bundle protocol (`window.__ModuleLoader__.load`
 * with a factory returning cordis-plugin exports): the bundle is served as a
 * classic script, so it may not be an ES module, and the bare specifiers it
 * requires are answered by the shell's module table. Only `react` is required
 * here — the card is built from plain elements and inline styles, which keeps it
 * clear of every other package's arrival order.
 *
 * The host half serves the route this card talks to, and registers the settings
 * namespace this card is dispatched by; `NAMESPACE` below is that shared value.
 */

window.__ModuleLoader__.load({
  id: '@harness-desktop/dsh-plugin-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** Must equal the namespace the host half registers. */
    var NAMESPACE = 'harness-desktop-plugins';
    var ROUTE = '/harness-desktop/plugins';

    var TEXT = {
      zh: {
        title: '插件管理',
        intro: '从 npm 安装 dsh 插件，也可以卸载、更新已安装的插件。',
        unavailable:
          '当前实例无法安装插件：它不是在 Harness Desktop 里启动的，没有随应用内置的 pnpm。',
        unavailableHint: '请改用桌面客户端打开本页面。',
        placeholder: '包名、包名@版本、.tgz 路径或 URL；多个规格用空格或逗号分隔',
        install: '安装',
        refresh: '刷新',
        remove: '卸载',
        update: '更新',
        builtIn: '内置',
        notMounted: '未挂载为插件层',
        missing: '文件缺失',
        managed: '本应用管理',
        layer: '插件层',
        restart: '需要重启服务才能生效',
        restartNow: '立即重启',
        restarting: '正在重启，页面稍后自动回来…',
        empty: 'profile 里还没有插件。',
        confirmRemove: '确定卸载',
        confirmRemoveTail: '？卸载后需要重启才会生效。',
        failed: '操作失败'
      },
      en: {
        title: 'Plugins',
        intro:
          'Install dsh plugins from npm, and remove or update the ones already installed.',
        unavailable:
          'This instance cannot install plugins: it was not started by Harness Desktop, so it has no bundled pnpm.',
        unavailableHint: 'Open this page from the desktop application instead.',
        placeholder: 'package, package@version, path to a .tgz, or URL; separate several with spaces or commas',
        install: 'Install',
        refresh: 'Refresh',
        remove: 'Remove',
        update: 'Update',
        builtIn: 'built-in',
        notMounted: 'not mounted as a bundle',
        missing: 'files missing',
        managed: 'managed by this app',
        layer: 'profile layer',
        restart: 'Restart the service to apply the change',
        restartNow: 'Restart now',
        restarting: 'Restarting — this page will come back on its own…',
        empty: 'No plugins in this profile yet.',
        confirmRemove: 'Remove',
        confirmRemoveTail: '? The change applies after a restart.',
        failed: 'Action failed'
      }
    };

    function labels() {
      var lang = (
        document.documentElement.lang ||
        navigator.language ||
        'en'
      ).toLowerCase();
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en;
    }

    function readBody(response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            throw new Error(body.error || 'HTTP ' + response.status);
          }
          return body;
        });
    }

    function load() {
      return fetch(ROUTE).then(readBody);
    }

    function act(action, spec) {
      return fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, spec: spec })
      }).then(readBody);
    }

    function createCard(react) {
      var h = react.createElement;

      var BADGE = {
        display: 'inline-block',
        padding: '1px 6px',
        marginRight: '6px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.35)',
        fontSize: '11px',
        lineHeight: '16px',
        opacity: 0.85
      };

      var BUTTON = {
        padding: '4px 10px',
        marginLeft: '6px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px'
      };

      function button(label, onClick, options) {
        var opts = options || {};
        return h(
          'button',
          {
            type: 'button',
            onClick: onClick,
            disabled: opts.disabled === true,
            style: Object.assign({}, BUTTON, {
              opacity: opts.disabled === true ? 0.5 : 1,
              cursor: opts.disabled === true ? 'default' : 'pointer'
            })
          },
          label
        );
      }

      return function PluginManagerCard() {
        var store = react.useState({
          status: 'loading',
          data: null,
          busy: false,
          error: '',
          output: '',
          restart: false,
          restarting: false
        });
        var state = store[0];
        var setState = store[1];
        var draft = react.useState('');
        var spec = draft[0];
        var setSpec = draft[1];
        var t = labels();

        function update(patch) {
          setState(function (previous) {
            return Object.assign({}, previous, patch);
          });
        }

        function refresh() {
          update({ status: 'loading', error: '' });
          load()
            .then(function (data) {
              setState(function (previous) {
                return Object.assign({}, previous, {
                  status: 'ready',
                  data: data
                });
              });
            })
            .catch(function (error) {
              update({ status: 'ready', error: String(error.message || error) });
            });
        }

        react.useEffect(refresh, []);

        function run(action, value) {
          update({ busy: true, error: '', output: '' });
          act(action, value)
            .then(function (body) {
              setState(function (previous) {
                return Object.assign({}, previous, {
                  busy: false,
                  output: body.output || '',
                  // The command answered with its own failure: keep the output,
                  // which is the only place the reason is written down.
                  error: body.ok === false ? body.error || t.failed : '',
                  restart: previous.restart || body.restartRequired === true,
                  data:
                    body.plugins === undefined
                      ? previous.data
                      : Object.assign({}, previous.data, {
                          packages: body.plugins.packages
                        })
                });
              });
            })
            .catch(function (error) {
              update({
                busy: false,
                error: String(error.message || error)
              });
            });
        }

        function restartNow() {
          update({ busy: true, restarting: true, error: '', output: '' });
          act('restart').catch(function () {
            // The service exits with the restart code before the response always
            // lands, and the shell then replaces this page; a network error here
            // is the expected shape of success.
          });
        }

        // Three states, not two: a host half that answered "no bundled pnpm" is
        // not the same as one this page could not reach at all.
        var reachable = state.data !== null;
        var available = reachable && state.data.available !== false;
        var packages = (state.data && state.data.packages) || [];

        var header = h(
          'div',
          null,
          h(
            'div',
            { style: { fontSize: '14px', fontWeight: 600 } },
            t.title
          ),
          reachable
            ? h(
                'div',
                {
                  style: {
                    marginTop: '4px',
                    fontSize: '12px',
                    opacity: 0.7,
                    lineHeight: '18px'
                  }
                },
                available ? t.intro : t.unavailable
              )
            : null
        );

        var installRow =
          !available
            ? null
            : h(
                'div',
                { style: { display: 'flex', marginTop: '12px' } },
                h('input', {
                  value: spec,
                  placeholder: t.placeholder,
                  disabled: state.busy,
                  onChange: function (event) {
                    setSpec(event.target.value);
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' && spec.trim().length > 0) {
                      run('add', spec.trim());
                      setSpec('');
                    }
                  },
                  style: {
                    flex: 1,
                    padding: '6px 10px',
                    borderRadius: '8px',
                    border: '1px solid rgba(127,127,127,.4)',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: '12px'
                  }
                }),
                button(
                  t.install,
                  function () {
                    if (spec.trim().length > 0) {
                      run('add', spec.trim());
                      setSpec('');
                    }
                  },
                  { disabled: state.busy || spec.trim().length === 0 }
                ),
                button(t.refresh, refresh, { disabled: state.busy })
              );

        var rows = packages.map(function (entry) {
          var badges = [];
          if (entry.bundle) {
            badges.push(t.layer);
          } else {
            badges.push(t.notMounted);
          }
          if (entry.builtIn) {
            badges.push(t.builtIn);
          }
          if (!entry.installed) {
            badges.push(t.missing);
          }

          return h(
            'div',
            {
              key: entry.name,
              style: {
                display: 'flex',
                alignItems: 'center',
                padding: '6px 0',
                borderTop: '1px solid rgba(127,127,127,.2)'
              }
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h(
                'div',
                {
                  style: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '12px',
                    overflowWrap: 'anywhere'
                  }
                },
                entry.name,
                entry.version ? ' @ ' + entry.version : ''
              ),
              h(
                'div',
                { style: { marginTop: '3px' } },
                badges.map(function (badge, index) {
                  return h('span', { key: index, style: BADGE }, badge);
                })
              )
            ),
            entry.removable
              ? button(
                  t.remove,
                  function () {
                    if (
                      window.confirm(
                        t.confirmRemove + ' ' + entry.name + t.confirmRemoveTail
                      )
                    ) {
                      run('remove', entry.name);
                    }
                  },
                  { disabled: state.busy }
                )
              : null,
            entry.removable
              ? button(
                  t.update,
                  function () {
                    run('update', entry.name);
                  },
                  { disabled: state.busy }
                )
              : null
          );
        });

        var list =
          state.status === 'loading'
            ? h(
                'div',
                { style: { marginTop: '12px', fontSize: '12px', opacity: 0.7 } },
                '…'
              )
            : h(
                'div',
                { style: { marginTop: '12px' } },
                rows.length === 0
                  ? h(
                      'div',
                      { style: { fontSize: '12px', opacity: 0.7 } },
                      t.empty
                    )
                  : rows
              );

        var notice =
          state.error.length > 0
            ? h(
                'div',
                {
                  style: {
                    marginTop: '10px',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    background: 'rgba(220,38,38,.12)',
                    fontSize: '12px',
                    lineHeight: '18px',
                    overflowWrap: 'anywhere'
                  }
                },
                t.failed + ': ' + state.error
              )
            : null;

        var restartBanner = state.restarting
          ? h(
              'div',
              {
                style: {
                  marginTop: '10px',
                  padding: '6px 10px',
                  borderRadius: '8px',
                  background: 'rgba(37,99,235,.12)',
                  fontSize: '12px'
                }
              },
              t.restarting
            )
          : state.restart
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    marginTop: '10px',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    background: 'rgba(37,99,235,.12)',
                    fontSize: '12px'
                  }
                },
                h('span', { style: { flex: 1 } }, t.restart),
                button(t.restartNow, restartNow, { disabled: state.busy })
              )
            : null;

        var output =
          state.output.length > 0
            ? h(
                'pre',
                {
                  style: {
                    marginTop: '10px',
                    maxHeight: '160px',
                    overflow: 'auto',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    background: 'rgba(127,127,127,.12)',
                    fontSize: '11px',
                    lineHeight: '16px',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere'
                  }
                },
                state.output
              )
            : null;

        var hint =
          state.data !== null && !available
            ? h(
                'div',
                { style: { marginTop: '6px', fontSize: '12px', opacity: 0.7 } },
                t.unavailableHint
              )
            : null;

        return h(
          'div',
          {
            style: {
              border: '1px solid rgba(127,127,127,.35)',
              borderRadius: '12px',
              padding: '14px 16px'
            }
          },
          header,
          hint,
          installRow,
          list,
          notice,
          restartBanner,
          output
        );
      };
    }

    function apply(ctx) {
      var react;
      try {
        react = require('react');
      } catch (error) {
        // Registering the bundle without a card beats failing its load: a
        // client bundle that never registers its id breaks the whole page.
        console.error('[plugin-manager] react is unavailable: ' + error);
        return;
      }

      var Card = createCard(react);

      // Only mount where the host half actually answers: in a build without it
      // (a plain `dsh web`), the settings page would otherwise show a card that
      // can never do anything.
      fetch(ROUTE)
        .then(function (response) {
          if (!response.ok) {
            return;
          }
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              { name: 'settings.plugin.item', key: NAMESPACE },
              Card
            );
          });
        })
        .catch(function () {});
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  }
});
