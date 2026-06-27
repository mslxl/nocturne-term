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
    title: { en: "New Terminal", zh: "新建终端" },
    scope: { en: "Terminal", zh: "终端" },
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
