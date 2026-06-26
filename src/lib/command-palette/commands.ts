import type { StaticPaletteCommand } from "./search";

export const staticPaletteCommands: StaticPaletteCommand[] = [
  {
    id: "settings.open",
    title: { en: "Open Settings", zh: "打开设置" },
    scope: { en: "App", zh: "应用" },
    shortcut: "Meta+,",
    keywords: {
      en: ["settings", "preferences", "config", "configuration"],
      zh: ["设置", "偏好", "配置"],
      pinyin: ["shezhi", "sz", "pianhao", "ph", "peizhi", "pz"],
    },
  },
  {
    id: "profile.new",
    title: { en: "New Profile", zh: "新建配置档案" },
    scope: { en: "Profile", zh: "配置档案" },
    keywords: {
      en: ["profile", "new profile", "create profile"],
      zh: ["新建", "配置档案", "档案"],
      pinyin: ["xinjian", "xj", "peizhidangan", "pzdangan", "pzda", "dangan", "da"],
    },
  },
  {
    id: "hosts.openManager",
    title: { en: "Open Host Manager", zh: "打开主机管理" },
    scope: { en: "Hosts", zh: "主机" },
    keywords: {
      en: ["hosts", "host manager", "ssh hosts", "connections"],
      zh: ["主机", "主机管理", "连接", "ssh"],
      pinyin: ["zhuji", "zj", "zhuji guanli", "zjgl", "lianjie", "lj"],
    },
  },
  {
    id: "terminal.newSession",
    title: { en: "New Session", zh: "新建 Session" },
    scope: { en: "Session", zh: "Session" },
    shortcut: "Meta+T",
    keywords: {
      en: ["session", "new session", "tab", "new tab", "terminal"],
      zh: ["新建会话", "会话", "新建标签", "标签", "终端"],
      pinyin: ["xinjianhuihua", "xjhh", "huihua", "hh", "xinjianbiaoqian", "xjbq", "biaoqian", "bq", "zhongduan", "zd"],
    },
  },
  {
    id: "tool.openResources",
    title: { en: "Open Resource Monitor", zh: "打开资源监视器" },
    scope: { en: "Workspace Tool", zh: "Workspace 工具" },
    keywords: {
      en: ["resource monitor", "resources", "cpu", "memory", "swap", "gpu", "metrics"],
      zh: ["资源监视器", "资源", "监控", "cpu", "内存", "交换", "显存", "gpu"],
      pinyin: ["ziyuanjianshiqi", "zyjsq", "ziyuan", "zy", "jiankong", "jk", "neicun", "nc", "jiaohuan", "jh", "xiancun", "xc"],
    },
  },
  {
    id: "tool.openTerminalSessions",
    title: { en: "Open Terminals", zh: "打开终端" },
    scope: { en: "Workspace Tool", zh: "Workspace 工具" },
    keywords: {
      en: ["terminal sessions", "sessions", "terminals", "detached", "history", "persistent terminal"],
      zh: ["终端会话", "会话", "终端", "分离", "历史", "持久终端"],
      pinyin: ["zhongduanhuihua", "zdhh", "huihua", "hh", "zhongduan", "zd", "fenli", "fl", "lishi", "ls"],
    },
  },
  {
    id: "terminal.splitRight",
    title: { en: "Split Right", zh: "向右拆分" },
    scope: { en: "Terminal", zh: "终端" },
    shortcut: "Meta+D",
    keywords: {
      en: ["split", "split pane", "right", "pane"],
      zh: ["拆分", "分屏", "右侧", "窗格", "终端"],
      pinyin: ["chaifen", "cf", "fenping", "fp", "youce", "yc", "chuangge", "cg", "zhongduan", "zd"],
    },
  },
  {
    id: "terminal.splitDown",
    title: { en: "Split Down", zh: "向下拆分" },
    scope: { en: "Terminal", zh: "终端" },
    shortcut: "Meta+Shift+D",
    keywords: {
      en: ["split", "split pane", "down", "pane"],
      zh: ["拆分", "分屏", "下方", "窗格", "终端"],
      pinyin: ["chaifen", "cf", "fenping", "fp", "xiafang", "xf", "chuangge", "cg", "zhongduan", "zd"],
    },
  },
  {
    id: "terminal.splitLeft",
    title: { en: "Split Left", zh: "向左拆分" },
    scope: { en: "Terminal", zh: "终端" },
    shortcut: "Meta+Alt+D",
    keywords: {
      en: ["split", "split pane", "left", "pane"],
      zh: ["拆分", "分屏", "左侧", "窗格", "终端"],
      pinyin: ["chaifen", "cf", "fenping", "fp", "zuoce", "zc", "chuangge", "cg", "zhongduan", "zd"],
    },
  },
  {
    id: "terminal.splitUp",
    title: { en: "Split Up", zh: "向上拆分" },
    scope: { en: "Terminal", zh: "终端" },
    shortcut: "Meta+Alt+Shift+D",
    keywords: {
      en: ["split", "split pane", "up", "pane"],
      zh: ["拆分", "分屏", "上方", "窗格", "终端"],
      pinyin: ["chaifen", "cf", "fenping", "fp", "shangfang", "sf", "chuangge", "cg", "zhongduan", "zd"],
    },
  },
  {
    id: "terminal.movePaneLeft",
    title: { en: "Move Pane Left", zh: "向左移动窗格" },
    scope: { en: "Pane", zh: "窗格" },
    keywords: {
      en: ["move pane", "move split", "left", "pane"],
      zh: ["移动", "窗格", "左侧", "分屏"],
      pinyin: ["yidong", "yd", "chuangge", "cg", "zuoce", "zc", "fenping", "fp"],
    },
  },
  {
    id: "terminal.movePaneRight",
    title: { en: "Move Pane Right", zh: "向右移动窗格" },
    scope: { en: "Pane", zh: "窗格" },
    keywords: {
      en: ["move pane", "move split", "right", "pane"],
      zh: ["移动", "窗格", "右侧", "分屏"],
      pinyin: ["yidong", "yd", "chuangge", "cg", "youce", "yc", "fenping", "fp"],
    },
  },
  {
    id: "terminal.movePaneUp",
    title: { en: "Move Pane Up", zh: "向上移动窗格" },
    scope: { en: "Pane", zh: "窗格" },
    keywords: {
      en: ["move pane", "move split", "up", "pane"],
      zh: ["移动", "窗格", "上方", "分屏"],
      pinyin: ["yidong", "yd", "chuangge", "cg", "shangfang", "sf", "fenping", "fp"],
    },
  },
  {
    id: "terminal.movePaneDown",
    title: { en: "Move Pane Down", zh: "向下移动窗格" },
    scope: { en: "Pane", zh: "窗格" },
    keywords: {
      en: ["move pane", "move split", "down", "pane"],
      zh: ["移动", "窗格", "下方", "分屏"],
      pinyin: ["yidong", "yd", "chuangge", "cg", "xiafang", "xf", "fenping", "fp"],
    },
  },
  {
    id: "terminal.togglePaneZoom",
    title: { en: "Toggle Pane Zoom", zh: "切换窗格缩放" },
    scope: { en: "Pane", zh: "窗格" },
    keywords: {
      en: ["zoom", "maximize pane", "restore panes", "focus pane"],
      zh: ["缩放", "放大", "还原", "窗格"],
      pinyin: ["suofang", "sf", "fangda", "fd", "huanyuan", "hy", "chuangge", "cg"],
    },
  },
  {
    id: "ui.theme.system",
    title: { en: "Switch Theme: System", zh: "切换主题：跟随系统" },
    scope: { en: "Theme", zh: "主题" },
    keywords: {
      en: ["theme", "system theme", "appearance"],
      zh: ["主题", "跟随系统", "外观"],
      pinyin: ["zhuti", "zt", "gensuixitong", "gsxt", "waiguan", "wg"],
    },
  },
  {
    id: "ui.theme.light",
    title: { en: "Switch Theme: Light", zh: "切换主题：浅色" },
    scope: { en: "Theme", zh: "主题" },
    keywords: {
      en: ["theme", "light theme", "appearance"],
      zh: ["主题", "浅色", "外观"],
      pinyin: ["zhuti", "zt", "qianse", "qs", "waiguan", "wg"],
    },
  },
  {
    id: "ui.theme.dark",
    title: { en: "Switch Theme: Dark", zh: "切换主题：深色" },
    scope: { en: "Theme", zh: "主题" },
    keywords: {
      en: ["theme", "dark theme", "appearance"],
      zh: ["主题", "深色", "外观"],
      pinyin: ["zhuti", "zt", "shense", "ss", "waiguan", "wg"],
    },
  },
];
