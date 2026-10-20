// 脱敏自查 + 结构自查：这个目录里还残留个人信息没有，说好的「零依赖」还成立不成立。
//
// 用法：
//   node check-clean.mjs              扫全部该扫的文件
//   node check-clean.mjs server.py    只扫指定的
//
// ⚠ 本文件只写通用模式，具体的人名、主机名、路径名一律放 .private-terms
//   （已 gitignore，见那个文件里的说明）。这个脚本随仓库公开，
//   把私有的词写进来，等于把词表本身印在纸上。
import fs from 'node:fs'
import path from 'node:path'

const 本目录 = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const 本文件名 = path.basename(new URL(import.meta.url).pathname)

// 明确点名，不用后缀过滤 —— LICENSE / NOTICE / .gitignore 没有后缀，按后缀筛会漏掉它们。
// 加了东西进仓库就往这里补一行，漏一个就是少查一个。
const 该扫 = ['server.py', 'prompts.py', 'room_store.py', 'room.json', 'config.example.json',
              'static/index.html', 'static/room.js', 'README.md', 'LICENSE', 'NOTICE', '.gitignore']

// ── 通用检查：任何项目都适用，不含任何具体的人或机器 ────────────────
const 通用 = [
  ['绝对路径',   /(?<![\w+.])[A-Za-z]:[\\/]|\/(?:home|Users|root)\/[\w.-]/],
  // 127.0.0.1 是回环地址，谁写都是它，不指认任何人的机器；10./192.168./172.16-31. 才是真内网
  ['私网地址',   /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/],
  // 查的是**真 key 的形状**，不是「api_key」这个键名 —— 配置模板里那个键名是必须出现的
  ['疑似真key',  /\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{20,}|bearer\s+[A-Za-z0-9._-]{24,}/i],
  ['私钥块',     /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['内嵌照片',   /data:image\/jpe?g/],
  ['邮箱',       /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
]

// 这个项目用得到的标准库（零依赖是它的卖点之一，多一个 import 就得在这里解释）
const 标准库 = new Set(['json', 'os', 'sys', 'urllib', 'http', 'threading', 'time', 'random',
                        'string', 'difflib', 're', 'io', 'socket', 'base64', 'hashlib',
                        'datetime', 'pathlib', 'collections', 'itertools', 'functools',
                        'math', 'logging', 'argparse', 'textwrap', 'unicodedata', 'html'])
const 自己的模块 = new Set(['prompts', 'room_store', 'server'])

// ── 项目特有词：从 .private-terms 读（gitignore 掉的，一行一个，# 开头是注释）──
function 读私有词() {
  const P = path.join(本目录, '.private-terms')
  if (!fs.existsSync(P)) return []
  return fs.readFileSync(P, 'utf8').split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
}

function 转义(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

const 私有词 = 读私有词()
const 检查表 = [...通用]
if (私有词.length) 检查表.push(['项目特有词', new RegExp(私有词.map(转义).join('|'), 'i')])

// ── 扫描 ────────────────────────────────────────────────────────────
let 文件表 = process.argv.slice(2)
if (!文件表.length) {
  文件表 = 该扫.filter(f => f !== 本文件名)
    .map(f => path.join(本目录, f))
    .filter(f => fs.existsSync(f))
}

let 脏 = 0
for (const P of 文件表) {
  const h = fs.readFileSync(P, 'utf8')
  const 名 = path.basename(P)
  // LICENSE 的版权署名是有意公开的，只放过署名那一行
  const 跳过署名 = /^LICENSE$/i.test(名)
  console.log('\n检查 %s（%d 字节，%d 行）', 名, Buffer.byteLength(h), h.split('\n').length)
  console.log('【必须为 0】')
  for (const [项, re] of 检查表) {
    const 行表 = h.split('\n').filter(l => !(跳过署名 && /copyright|\(c\)\s*\d{4}/i.test(l)))
    const 全文 = 行表.join('\n')
    const 中 = 全文.match(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g')) || []
    if (中.length) 脏++
    console.log('  %s %s %d', 中.length ? '✗' : '✓', 项.padEnd(10), 中.length)
    if (中.length) {
      const 逐行 = new RegExp(re.source, re.flags.includes('i') ? 'i' : '')
      for (const l of 行表.filter(l => 逐行.test(l)).slice(0, 3))
        console.log('        ' + l.trim().slice(0, 96))
    }
  }

  if (/^index\.html$/i.test(名)) {
    console.log('【结构】')
    // 这页的卖点之一：不加载任何外部东西（没有 CDN、没有 webfont、没有框架）
    const 外部 = [...h.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1])
    const 只一个 = 外部.length === 1 && 外部[0] === '/room.js'
    console.log('  %s 外部脚本 %d 个：%s', 只一个 ? '✓' : '✗', 外部.length, 外部.join(', ') || '(无)')
    if (!只一个) 脏++

    const 外链 = [...h.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map(m => m[1])
    console.log('  %s 外链资源 %d 个：%s', 外链.length ? '✗' : '✓', 外链.length, 外链.join(', ') || '(无)')
    if (外链.length) 脏++

    const 字体 = /@font-face/.test(h)
    console.log('  %s @font-face %d 处（这页用系统字体，不拉 webfont）', 字体 ? '✗' : '✓', 字体 ? 1 : 0)
    if (字体) 脏++
  }

  if (/\.py$/i.test(名)) {
    console.log('【结构】')
    const 引入 = [...h.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map(m => m[1].split('.')[0])
    const 多出来 = [...new Set(引入)].filter(m => !标准库.has(m) && !自己的模块.has(m))
    console.log('  %s 零依赖：用到 %d 个模块，多出来的：%s',
      多出来.length ? '✗' : '✓', new Set(引入).size, 多出来.join(', ') || '(无)')
    if (多出来.length) 脏++
  }
}

if (!私有词.length) {
  console.log('\n注：没找到 .private-terms，本轮只跑了通用检查。')
  console.log('    要连人名/主机名一起查，就在本目录建一个 .private-terms，一行一个词。')
}
console.log('\n' + (脏 ? '✗ ' + 脏 + ' 项没过' : '✓ 干净（' + 文件表.length + ' 个文件）'))
process.exit(脏 ? 1 : 0)
