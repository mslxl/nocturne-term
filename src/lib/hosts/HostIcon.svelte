<script lang="ts">
  import type { ConnectionHostIcon } from "$lib/bindings";
  import { hostIconLabel } from "$lib/hosts/icons";
  import Terminal from "~icons/lucide/terminal";
  import SquareTerminal from "~icons/lucide/square-terminal";
  import Server from "~icons/lucide/server";
  import Database from "~icons/lucide/database";
  import Cloud from "~icons/lucide/cloud";
  import Network from "~icons/lucide/network";
  import Router from "~icons/lucide/router";
  import Monitor from "~icons/lucide/monitor";
  import Upload from "~icons/lucide/upload";
  import Aws from "~icons/devicon/amazonwebservices";
  import Azure from "~icons/devicon/azure";
  import GoogleCloud from "~icons/devicon/googlecloud";
  import DigitalOcean from "~icons/devicon/digitalocean";
  import Cloudflare from "~icons/devicon/cloudflare";
  import Oracle from "~icons/devicon/oracle";
  import Heroku from "~icons/devicon/heroku";
  import Vercel from "~icons/devicon/vercel";
  import Netlify from "~icons/devicon/netlify";
  import Postgresql from "~icons/devicon/postgresql";
  import Redis from "~icons/devicon/redis";
  import Mysql from "~icons/devicon/mysql";
  import Mariadb from "~icons/devicon/mariadb";
  import Mongodb from "~icons/devicon/mongodb";
  import Sqlite from "~icons/devicon/sqlite";
  import SqlServer from "~icons/devicon/microsoftsqlserver";
  import Cassandra from "~icons/devicon/cassandra";
  import Elasticsearch from "~icons/devicon/elasticsearch";
  import Clickhouse from "~icons/devicon/clickhouse";
  import AlmaLinux from "~icons/simple-icons/almalinux";
  import AlpineLinux from "~icons/simple-icons/alpinelinux";
  import Android from "~icons/simple-icons/android";
  import ArchLinux from "~icons/simple-icons/archlinux";
  import ArtixLinux from "~icons/simple-icons/artixlinux";
  import AsahiLinux from "~icons/simple-icons/asahilinux";
  import Bsd from "~icons/simple-icons/bsd";
  import Centos from "~icons/simple-icons/centos";
  import Debian from "~icons/simple-icons/debian";
  import Deepin from "~icons/simple-icons/deepin";
  import EndeavourOs from "~icons/simple-icons/endeavouros";
  import Fedora from "~icons/simple-icons/fedora";
  import FreeBsd from "~icons/simple-icons/freebsd";
  import GarudaLinux from "~icons/simple-icons/garudalinux";
  import Gentoo from "~icons/simple-icons/gentoo";
  import HarmonyOs from "~icons/simple-icons/harmonyos";
  import Ios from "~icons/simple-icons/ios";
  import KaliLinux from "~icons/simple-icons/kalilinux";
  import Kubuntu from "~icons/simple-icons/kubuntu";
  import Linux from "~icons/simple-icons/linux";
  import LinuxMint from "~icons/simple-icons/linuxmint";
  import Lubuntu from "~icons/simple-icons/lubuntu";
  import Manjaro from "~icons/simple-icons/manjaro";
  import MxLinux from "~icons/simple-icons/mxlinux";
  import NetBsd from "~icons/simple-icons/netbsd";
  import NixOs from "~icons/simple-icons/nixos";
  import NobaraLinux from "~icons/simple-icons/nobaralinux";
  import OpenBsd from "~icons/simple-icons/openbsd";
  import OpenSuse from "~icons/simple-icons/opensuse";
  import ParrotSecurity from "~icons/simple-icons/parrotsecurity";
  import PopOs from "~icons/simple-icons/popos";
  import RaspberryPi from "~icons/simple-icons/raspberrypi";
  import ReactOs from "~icons/simple-icons/reactos";
  import RedHat from "~icons/simple-icons/redhat";
  import RockyLinux from "~icons/simple-icons/rockylinux";
  import Slackware from "~icons/simple-icons/slackware";
  import Solus from "~icons/simple-icons/solus";
  import Suse from "~icons/simple-icons/suse";
  import Tails from "~icons/simple-icons/tails";
  import Ubuntu from "~icons/simple-icons/ubuntu";
  import UbuntuMate from "~icons/simple-icons/ubuntumate";
  import VoidLinux from "~icons/simple-icons/voidlinux";
  import Windows from "~icons/simple-icons/windows";
  import Windows10 from "~icons/simple-icons/windows10";
  import Windows95 from "~icons/simple-icons/windows95";
  import WindowsXp from "~icons/simple-icons/windowsxp";
  import Xubuntu from "~icons/simple-icons/xubuntu";
  import Zorin from "~icons/simple-icons/zorin";
  import AlibabaCloud from "~icons/simple-icons/alibabacloud";
  import Hetzner from "~icons/simple-icons/hetzner";
  import Akamai from "~icons/simple-icons/akamai";
  import Snowflake from "~icons/simple-icons/snowflake";
  import OpenSearch from "~icons/simple-icons/opensearch";

  type Props = {
    icon: ConnectionHostIcon;
    size?: "small" | "medium" | "large";
    title?: string;
    framed?: boolean;
  };

  let { icon, size = "medium", title, framed = false }: Props = $props();

  const catalogComponents = {
    "lucide:terminal": Terminal,
    "lucide:square-terminal": SquareTerminal,
    "lucide:server": Server,
    "lucide:database": Database,
    "lucide:cloud": Cloud,
    "lucide:network": Network,
    "lucide:router": Router,
    "lucide:monitor": Monitor,
    "lucide:upload": Upload,
    "devicon:ssh": Server,
    "devicon:amazonwebservices": Aws,
    "devicon:azure": Azure,
    "devicon:googlecloud": GoogleCloud,
    "devicon:digitalocean": DigitalOcean,
    "devicon:cloudflare": Cloudflare,
    "devicon:oracle": Oracle,
    "devicon:heroku": Heroku,
    "devicon:vercel": Vercel,
    "devicon:netlify": Netlify,
    "devicon:postgresql": Postgresql,
    "devicon:redis": Redis,
    "devicon:mysql": Mysql,
    "devicon:mariadb": Mariadb,
    "devicon:mongodb": Mongodb,
    "devicon:sqlite": Sqlite,
    "devicon:microsoftsqlserver": SqlServer,
    "devicon:cassandra": Cassandra,
    "devicon:elasticsearch": Elasticsearch,
    "devicon:clickhouse": Clickhouse,
    "simple-icons:almalinux": AlmaLinux,
    "simple-icons:alpinelinux": AlpineLinux,
    "simple-icons:android": Android,
    "simple-icons:archlinux": ArchLinux,
    "simple-icons:artixlinux": ArtixLinux,
    "simple-icons:asahilinux": AsahiLinux,
    "simple-icons:bsd": Bsd,
    "simple-icons:centos": Centos,
    "simple-icons:debian": Debian,
    "simple-icons:deepin": Deepin,
    "simple-icons:endeavouros": EndeavourOs,
    "simple-icons:fedora": Fedora,
    "simple-icons:freebsd": FreeBsd,
    "simple-icons:garudalinux": GarudaLinux,
    "simple-icons:gentoo": Gentoo,
    "simple-icons:harmonyos": HarmonyOs,
    "simple-icons:ios": Ios,
    "simple-icons:kalilinux": KaliLinux,
    "simple-icons:kubuntu": Kubuntu,
    "simple-icons:linux": Linux,
    "simple-icons:linuxmint": LinuxMint,
    "simple-icons:lubuntu": Lubuntu,
    "simple-icons:manjaro": Manjaro,
    "simple-icons:mxlinux": MxLinux,
    "simple-icons:netbsd": NetBsd,
    "simple-icons:nixos": NixOs,
    "simple-icons:nobaralinux": NobaraLinux,
    "simple-icons:openbsd": OpenBsd,
    "simple-icons:opensuse": OpenSuse,
    "simple-icons:parrotsecurity": ParrotSecurity,
    "simple-icons:popos": PopOs,
    "simple-icons:raspberrypi": RaspberryPi,
    "simple-icons:reactos": ReactOs,
    "simple-icons:redhat": RedHat,
    "simple-icons:rockylinux": RockyLinux,
    "simple-icons:slackware": Slackware,
    "simple-icons:solus": Solus,
    "simple-icons:suse": Suse,
    "simple-icons:tails": Tails,
    "simple-icons:ubuntu": Ubuntu,
    "simple-icons:ubuntumate": UbuntuMate,
    "simple-icons:voidlinux": VoidLinux,
    "simple-icons:windows": Windows,
    "simple-icons:windows10": Windows10,
    "simple-icons:windows95": Windows95,
    "simple-icons:windowsxp": WindowsXp,
    "simple-icons:xubuntu": Xubuntu,
    "simple-icons:zorin": Zorin,
    "simple-icons:alibabacloud": AlibabaCloud,
    "simple-icons:hetzner": Hetzner,
    "simple-icons:akamai": Akamai,
    "simple-icons:snowflake": Snowflake,
    "simple-icons:opensearch": OpenSearch,
  };

  const Component = $derived(icon.type === "catalog" ? catalogComponents[icon.name as keyof typeof catalogComponents] : null);
  const safeSvg = $derived(icon.type === "svg" ? sanitizedSvg(icon.svg) : "");
  const imageSrc = $derived(icon.type === "image" ? `data:${icon.mime};base64,${icon.data_base64}` : "");
  const accessibleTitle = $derived(title ?? hostIconLabel(icon));
  const forceFill = $derived(icon.type !== "catalog" || !icon.name.startsWith("lucide:"));

  function sanitizedSvg(svg: string): string {
    const trimmed = svg.trim();
    const lower = trimmed.toLowerCase();
    if (!lower.includes("<svg")) return "";
    if (lower.includes("<script") || lower.includes("<foreignobject") || lower.includes("javascript:") || lower.includes("http://") || lower.includes("https://")) return "";
    if (/\son[a-z]+\s*=/i.test(trimmed)) return "";
    return trimmed;
  }
</script>

<span class={`host-icon ${size}`} class:framed class:force-fill={forceFill} title={accessibleTitle} aria-label={accessibleTitle}>
  {#if Component}
    <Component />
  {:else if icon.type === "catalog" && icon.name === "local:tencentcloud"}
    <span class="tencent" aria-hidden="true">T</span>
  {:else if icon.type === "image"}
    <img src={imageSrc} alt="" />
  {:else if safeSvg}
    {@html safeSvg}
  {:else}
    <Server />
  {/if}
</span>

<style>
  .host-icon {
    --host-icon-size: 20px;
    --host-icon-inner-size: calc(var(--host-icon-size) * 0.76);
    width: var(--host-icon-size);
    height: var(--host-icon-size);
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    color: #18191b;
    line-height: 0;
  }

  :global(:root[data-theme="dark"]) .host-icon {
    color: #f5f6f7;
  }

  .host-icon.small {
    --host-icon-size: 16px;
  }

  .host-icon.large {
    --host-icon-size: 32px;
  }

  .host-icon.framed {
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, currentColor 7%, transparent);
  }

  .host-icon :global(svg),
  .host-icon img {
    width: var(--host-icon-inner-size);
    height: var(--host-icon-inner-size);
    display: block;
    object-fit: contain;
  }

  .host-icon:not(.framed) :global(svg),
  .host-icon:not(.framed) img {
    width: 100%;
    height: 100%;
  }

  .host-icon.force-fill :global(svg path),
  .host-icon.force-fill :global(svg circle),
  .host-icon.force-fill :global(svg rect),
  .host-icon.force-fill :global(svg polygon),
  .host-icon.force-fill :global(svg ellipse) {
    fill: currentColor !important;
  }

  .host-icon.force-fill :global(svg [stroke]:not([stroke="none"])) {
    stroke: currentColor !important;
  }

  .host-icon img {
    filter: grayscale(1) brightness(0);
  }

  :global(:root[data-theme="dark"]) .host-icon img {
    filter: grayscale(1) brightness(0) invert(1);
  }

  .tencent {
    width: var(--host-icon-inner-size);
    height: var(--host-icon-inner-size);
    display: grid;
    place-items: center;
    border-radius: 5px;
    border: 1px solid currentColor;
    color: currentColor;
    font-size: calc(var(--host-icon-size) * 0.62);
    font-weight: 700;
    line-height: 1;
  }
</style>
