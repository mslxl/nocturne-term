import type { ConnectionHostDocument, ConnectionHostEntry, ConnectionHostIcon } from "$lib/bindings";

export type CatalogHostIcon = Extract<ConnectionHostIcon, { type: "catalog" }>;

export type HostIconOption = {
  id: string;
  label: string;
  keywords: string[];
};

export type HostIconCategory = {
  id: "generic" | "os" | "cloud" | "database" | "custom";
  label: string;
  icons: HostIconOption[];
};

export const genericHostIcons: HostIconOption[] = [
  icon("lucide:terminal", "Terminal", ["shell", "local", "console"]),
  icon("lucide:square-terminal", "Shell", ["terminal", "console", "local"]),
  icon("lucide:server", "Server", ["host", "ssh", "machine"]),
  icon("lucide:database", "Database", ["db", "sql"]),
  icon("lucide:cloud", "Cloud", ["provider", "remote"]),
  icon("lucide:network", "Network", ["lan", "connection"]),
  icon("lucide:router", "Router", ["network", "telnet"]),
  icon("lucide:monitor", "Desktop", ["computer", "workstation"]),
];

const operatingSystemIcons: HostIconOption[] = [
  icon("simple-icons:almalinux", "AlmaLinux", ["alma", "linux"]),
  icon("simple-icons:alpinelinux", "Alpine Linux", ["alpine", "linux"]),
  icon("simple-icons:android", "Android", ["mobile", "linux"]),
  icon("simple-icons:archlinux", "Arch Linux", ["arch", "linux"]),
  icon("simple-icons:artixlinux", "Artix Linux", ["artix", "linux"]),
  icon("simple-icons:asahilinux", "Asahi Linux", ["asahi", "linux"]),
  icon("simple-icons:bsd", "BSD", ["unix"]),
  icon("simple-icons:centos", "CentOS", ["linux"]),
  icon("simple-icons:debian", "Debian", ["linux"]),
  icon("simple-icons:deepin", "deepin", ["linux"]),
  icon("simple-icons:endeavouros", "EndeavourOS", ["linux"]),
  icon("simple-icons:fedora", "Fedora", ["linux"]),
  icon("simple-icons:freebsd", "FreeBSD", ["bsd", "unix"]),
  icon("simple-icons:garudalinux", "Garuda Linux", ["linux"]),
  icon("simple-icons:gentoo", "Gentoo", ["linux"]),
  icon("simple-icons:harmonyos", "HarmonyOS", ["mobile"]),
  icon("simple-icons:ios", "iOS", ["apple", "mobile"]),
  icon("simple-icons:kalilinux", "Kali Linux", ["kali", "linux"]),
  icon("simple-icons:kubuntu", "Kubuntu", ["ubuntu", "linux"]),
  icon("simple-icons:linux", "Linux", ["kernel"]),
  icon("simple-icons:linuxmint", "Linux Mint", ["mint", "linux"]),
  icon("simple-icons:lubuntu", "Lubuntu", ["ubuntu", "linux"]),
  icon("simple-icons:manjaro", "Manjaro", ["linux"]),
  icon("simple-icons:mxlinux", "MX Linux", ["linux"]),
  icon("simple-icons:netbsd", "NetBSD", ["bsd", "unix"]),
  icon("simple-icons:nixos", "NixOS", ["nix", "linux"]),
  icon("simple-icons:nobaralinux", "Nobara Linux", ["linux"]),
  icon("simple-icons:openbsd", "OpenBSD", ["bsd", "unix"]),
  icon("simple-icons:opensuse", "openSUSE", ["suse", "linux"]),
  icon("simple-icons:parrotsecurity", "Parrot Security", ["linux"]),
  icon("simple-icons:popos", "Pop!_OS", ["pop", "linux"]),
  icon("simple-icons:raspberrypi", "Raspberry Pi", ["raspbian", "linux"]),
  icon("simple-icons:reactos", "ReactOS", ["windows"]),
  icon("simple-icons:redhat", "Red Hat", ["rhel", "linux"]),
  icon("simple-icons:rockylinux", "Rocky Linux", ["linux"]),
  icon("simple-icons:slackware", "Slackware", ["linux"]),
  icon("simple-icons:solus", "Solus", ["linux"]),
  icon("simple-icons:suse", "SUSE", ["linux"]),
  icon("simple-icons:tails", "Tails", ["linux"]),
  icon("simple-icons:ubuntu", "Ubuntu", ["linux"]),
  icon("simple-icons:ubuntumate", "Ubuntu MATE", ["ubuntu", "linux"]),
  icon("simple-icons:voidlinux", "Void Linux", ["linux"]),
  icon("simple-icons:windows", "Windows", ["microsoft"]),
  icon("simple-icons:windows10", "Windows 10", ["microsoft"]),
  icon("simple-icons:windows95", "Windows 95", ["microsoft"]),
  icon("simple-icons:windowsxp", "Windows XP", ["microsoft"]),
  icon("simple-icons:xubuntu", "Xubuntu", ["ubuntu", "linux"]),
  icon("simple-icons:zorin", "Zorin OS", ["linux"]),
];

const cloudProviderIcons: HostIconOption[] = [
  icon("devicon:amazonwebservices", "AWS", ["amazon", "cloud"]),
  icon("devicon:azure", "Azure", ["microsoft", "cloud"]),
  icon("devicon:googlecloud", "Google Cloud", ["gcp", "cloud"]),
  icon("devicon:digitalocean", "DigitalOcean", ["cloud"]),
  icon("devicon:cloudflare", "Cloudflare", ["cloud", "edge"]),
  icon("devicon:oracle", "Oracle", ["oci", "cloud"]),
  icon("devicon:heroku", "Heroku", ["cloud", "paas"]),
  icon("devicon:vercel", "Vercel", ["cloud", "frontend"]),
  icon("devicon:netlify", "Netlify", ["cloud", "frontend"]),
  icon("simple-icons:alibabacloud", "Alibaba Cloud", ["aliyun", "cloud"]),
  icon("simple-icons:hetzner", "Hetzner", ["cloud"]),
  icon("simple-icons:akamai", "Akamai", ["cloud", "edge"]),
  icon("simple-icons:snowflake", "Snowflake", ["cloud", "database"]),
  icon("simple-icons:opensearch", "OpenSearch", ["cloud", "search"]),
  icon("local:tencentcloud", "Tencent Cloud", ["tencent", "cloud", "qcloud"]),
];

const databaseIcons: HostIconOption[] = [
  icon("devicon:postgresql", "PostgreSQL", ["postgres", "database", "sql"]),
  icon("devicon:redis", "Redis", ["cache", "database"]),
  icon("devicon:mysql", "MySQL", ["database", "sql"]),
  icon("devicon:mariadb", "MariaDB", ["mysql", "database", "sql"]),
  icon("devicon:mongodb", "MongoDB", ["mongo", "database"]),
  icon("devicon:sqlite", "SQLite", ["database", "sql"]),
  icon("devicon:microsoftsqlserver", "SQL Server", ["mssql", "database", "sql"]),
  icon("devicon:cassandra", "Cassandra", ["database"]),
  icon("devicon:elasticsearch", "Elasticsearch", ["search", "database"]),
  icon("devicon:clickhouse", "ClickHouse", ["database", "analytics"]),
  icon("simple-icons:snowflake", "Snowflake", ["database", "warehouse"]),
  icon("simple-icons:opensearch", "OpenSearch", ["search", "database"]),
];

export const hostIconCategories: HostIconCategory[] = [
  { id: "generic", label: "Generic", icons: genericHostIcons },
  { id: "os", label: "Operating Systems", icons: operatingSystemIcons },
  { id: "cloud", label: "Cloud Providers", icons: cloudProviderIcons },
  { id: "database", label: "Databases", icons: databaseIcons },
  { id: "custom", label: "Custom", icons: [] },
];

export const hostIconOptions = hostIconCategories.flatMap((category) => category.icons);

const hostIconOptionById = new Map(hostIconOptions.map((option) => [option.id, option]));

export function catalogIcon(name: string): CatalogHostIcon {
  return { type: "catalog", name };
}

export function hostIconLabel(icon: ConnectionHostIcon | null | undefined): string {
  if (!icon) return "Default";
  if (icon.type === "catalog") {
    if (icon.name === "devicon:ssh") return "SSH";
    return hostIconOptionById.get(icon.name)?.label ?? icon.name;
  }
  if (icon.type === "image") return "Custom image";
  return "Custom SVG";
}

export function hostIconSearchText(option: HostIconOption): string {
  return [option.id, option.label, ...option.keywords].join(" ").toLowerCase();
}

export function resolveHostIcon(entry: ConnectionHostEntry): ConnectionHostIcon {
  return entry.document.icon ?? inferHostIcon(entry.document);
}

export function inferHostIcon(document: ConnectionHostDocument): ConnectionHostIcon {
  const haystack = [
    document.name,
    document.protocol,
    document.local?.command ?? "",
    document.local?.cwd ?? "",
    document.ssh?.hostname ?? "",
    document.ssh?.username ?? "",
    document.ssh?.proxy_jump ?? "",
    document.telnet?.hostname ?? "",
  ].join(" ").toLowerCase();
  const inferred = [
    ...cloudProviderIcons,
    ...databaseIcons,
    ...operatingSystemIcons,
  ].find((option) => option.keywords.some((keyword) => keyword.length > 2 && haystack.includes(keyword.toLowerCase())) || haystack.includes(option.label.toLowerCase()));
  if (inferred) return catalogIcon(inferred.id);
  if (document.protocol === "local") return catalogIcon("lucide:terminal");
  if (document.protocol === "telnet") return catalogIcon("lucide:router");
  return catalogIcon("lucide:server");
}

export function iconOption(id: string): HostIconOption | undefined {
  return hostIconOptionById.get(id);
}

function icon(id: string, label: string, keywords: string[] = []): HostIconOption {
  return { id, label, keywords };
}
