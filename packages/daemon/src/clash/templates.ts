/** The rule templates Clash Integration offers (docs/clash-v0.md §7.7), each a list of rules without a target — one
 *  goes direct, the other is rejected. They are the direct and the blocking parts of the configuration subscription
 *  services commonly hand out, as the user's own file had them on 2026-10-08, less the two addresses that were that
 *  user's own. A line: `TYPE,value` (`,no-resolve` after an address to match it only as given). */

/** Domestic & Local Direct. A rule that needs an address looked up first (a range, `GEOIP`) is served apart, after
 *  the subscription's own rules (build.ts). */
export const DOMESTIC_TEMPLATE: readonly string[] = [
  // Doubao and the ByteDance services it rests on
  "DOMAIN-KEYWORD,doubao", "DOMAIN-SUFFIX,volces.com", "DOMAIN-SUFFIX,volcengine.com", "DOMAIN-SUFFIX,byteimg.com", "DOMAIN-SUFFIX,bytedanceapi.com",
  // Local names and safety services
  "DOMAIN,safebrowsing.urlsec.qq.com", "DOMAIN,safebrowsing.googleapis.com", "DOMAIN,injections.adguard.org", "DOMAIN,local.adguard.org",
  "DOMAIN-SUFFIX,local", "DOMAIN-SUFFIX,10010.com",
  // Chinese desktop apps, by process (their helpers send the traffic)
  "PROCESS-NAME,WeChat", "PROCESS-NAME,WeChatAppEx Helper", "PROCESS-NAME,QQ", "PROCESS-NAME-WILDCARD,*QQ Helper*",
  "PROCESS-NAME-WILDCARD,*DingTalk*",
  // Domains commonly reached from China
  "DOMAIN-SUFFIX,cn", "DOMAIN-KEYWORD,-cn", "DOMAIN-SUFFIX,qq.com", "DOMAIN-SUFFIX,wechat.com", "DOMAIN-SUFFIX,tencent.com",
  "DOMAIN-SUFFIX,gtimg.com", "DOMAIN-SUFFIX,tenpay.com", "DOMAIN-SUFFIX,bilicdn1.com", "DOMAIN-SUFFIX,bilicdn2.com", "DOMAIN-SUFFIX,bilicdn3.com",
  "DOMAIN-SUFFIX,bilibili.com", "DOMAIN-SUFFIX,bilivideo.com", "DOMAIN-SUFFIX,biliapi.com", "DOMAIN-SUFFIX,biliapi.net", "DOMAIN-SUFFIX,hdslb.com",
  "DOMAIN-SUFFIX,biliimg.com", "DOMAIN-SUFFIX,xiaohongshu.com", "DOMAIN-SUFFIX,xhscdn.com", "DOMAIN-SUFFIX,dingtalk.com",
  "DOMAIN-SUFFIX,dingtalkapps.com", "DOMAIN-SUFFIX,apple.com", "DOMAIN-SUFFIX,apple-cloudkit.com", "DOMAIN-SUFFIX,apple-mapkit.com",
  "DOMAIN-SUFFIX,mzstatic.com", "DOMAIN-SUFFIX,icloud.com", "DOMAIN-SUFFIX,icloud-content.com", "DOMAIN-SUFFIX,me.com", "DOMAIN-SUFFIX,aaplimg.com",
  "DOMAIN-SUFFIX,cdn20.com", "DOMAIN-SUFFIX,cdn-apple.com", "DOMAIN-SUFFIX,akadns.net", "DOMAIN-SUFFIX,akamaiedge.net", "DOMAIN-SUFFIX,edgekey.net",
  "DOMAIN-SUFFIX,mwcloudcdn.com", "DOMAIN-SUFFIX,mwcname.com", "DOMAIN-SUFFIX,126.net", "DOMAIN-SUFFIX,36kr.com", "DOMAIN-SUFFIX,acfun.tv",
  "DOMAIN-SUFFIX,air-matters.com", "DOMAIN-SUFFIX,aixifan.com", "DOMAIN-KEYWORD,alicdn", "DOMAIN-KEYWORD,alipay", "DOMAIN-KEYWORD,taobao",
  "DOMAIN-SUFFIX,amap.com", "DOMAIN-SUFFIX,autonavi.com", "DOMAIN-KEYWORD,baidu", "DOMAIN-SUFFIX,bdimg.com", "DOMAIN-SUFFIX,bdstatic.com",
  "DOMAIN-SUFFIX,caiyunapp.com", "DOMAIN-SUFFIX,clouddn.com", "DOMAIN-SUFFIX,cnbeta.com", "DOMAIN-SUFFIX,cnbetacdn.com",
  "DOMAIN-SUFFIX,cootekservice.com", "DOMAIN-SUFFIX,csdn.net", "DOMAIN-SUFFIX,ctrip.com", "DOMAIN-SUFFIX,dgtle.com", "DOMAIN-SUFFIX,douban.com",
  "DOMAIN-SUFFIX,doubanio.com", "DOMAIN-SUFFIX,duokan.com", "DOMAIN-SUFFIX,easou.com", "DOMAIN-SUFFIX,ele.me", "DOMAIN-SUFFIX,feng.com",
  "DOMAIN-SUFFIX,fir.im", "DOMAIN-SUFFIX,frdic.com", "DOMAIN-SUFFIX,g-cores.com", "DOMAIN-SUFFIX,godic.net", "DOMAIN,cdn.hockeyapp.net",
  "DOMAIN-SUFFIX,hongxiu.com", "DOMAIN-SUFFIX,hxcdn.net", "DOMAIN-SUFFIX,iciba.com", "DOMAIN-SUFFIX,ifeng.com", "DOMAIN-SUFFIX,ifengimg.com",
  "DOMAIN-SUFFIX,ipip.net", "DOMAIN-SUFFIX,iqiyi.com", "DOMAIN-SUFFIX,jd.com", "DOMAIN-SUFFIX,jianshu.com", "DOMAIN-SUFFIX,knewone.com",
  "DOMAIN-SUFFIX,le.com", "DOMAIN-SUFFIX,lecloud.com", "DOMAIN-SUFFIX,lemicp.com", "DOMAIN-SUFFIX,licdn.com", "DOMAIN-SUFFIX,luoo.net",
  "DOMAIN-SUFFIX,mi.com", "DOMAIN-SUFFIX,miaopai.com", "DOMAIN-SUFFIX,microsoft.com", "DOMAIN-SUFFIX,microsoftonline.com", "DOMAIN-SUFFIX,miui.com",
  "DOMAIN-SUFFIX,miwifi.com", "DOMAIN-SUFFIX,mob.com", "DOMAIN-SUFFIX,office.com", "DOMAIN-SUFFIX,office365.com", "DOMAIN-KEYWORD,officecdn",
  "DOMAIN-SUFFIX,oschina.net", "DOMAIN-SUFFIX,ppsimg.com", "DOMAIN-SUFFIX,pstatp.com", "DOMAIN-SUFFIX,qcloud.com", "DOMAIN-SUFFIX,qdaily.com",
  "DOMAIN-SUFFIX,qdmm.com", "DOMAIN-SUFFIX,qhimg.com", "DOMAIN-SUFFIX,qhres.com", "DOMAIN-SUFFIX,qidian.com", "DOMAIN-SUFFIX,qihucdn.com",
  "DOMAIN-SUFFIX,qiniu.com", "DOMAIN-SUFFIX,qiniucdn.com", "DOMAIN-SUFFIX,qiyipic.com", "DOMAIN-SUFFIX,qqurl.com", "DOMAIN-SUFFIX,ruguoapp.com",
  "DOMAIN-SUFFIX,segmentfault.com", "DOMAIN-SUFFIX,sinaapp.com", "DOMAIN-SUFFIX,smzdm.com", "DOMAIN-SUFFIX,snapdrop.net", "DOMAIN-SUFFIX,sogou.com",
  "DOMAIN-SUFFIX,sogoucdn.com", "DOMAIN-SUFFIX,sohu.com", "DOMAIN-SUFFIX,soku.com", "DOMAIN-SUFFIX,speedtest.net", "DOMAIN-SUFFIX,sspai.com",
  "DOMAIN-SUFFIX,suning.com", "DOMAIN-SUFFIX,tianyancha.com", "DOMAIN-SUFFIX,tmall.com", "DOMAIN-SUFFIX,tudou.com", "DOMAIN-SUFFIX,umetrip.com",
  "DOMAIN-SUFFIX,upaiyun.com", "DOMAIN-SUFFIX,upyun.com", "DOMAIN-SUFFIX,veryzhun.com", "DOMAIN-SUFFIX,weather.com", "DOMAIN-SUFFIX,weibo.com",
  "DOMAIN-SUFFIX,xiami.com", "DOMAIN-SUFFIX,xiami.net", "DOMAIN-SUFFIX,xiaomicp.com", "DOMAIN-SUFFIX,ximalaya.com", "DOMAIN-SUFFIX,xmcdn.com",
  "DOMAIN-SUFFIX,xunlei.com", "DOMAIN-SUFFIX,yhd.com", "DOMAIN-SUFFIX,yihaodianimg.com", "DOMAIN-SUFFIX,yinxiang.com", "DOMAIN-SUFFIX,ykimg.com",
  "DOMAIN-SUFFIX,youdao.com", "DOMAIN-SUFFIX,youku.com", "DOMAIN-SUFFIX,zealer.com", "DOMAIN-SUFFIX,zhihu.com", "DOMAIN-SUFFIX,zhimg.com",
  "DOMAIN-SUFFIX,zimuzu.tv", "DOMAIN-SUFFIX,zoho.com",
  // Local networks and reserved ranges
  "IP-CIDR,127.0.0.0/8", "IP-CIDR,172.16.0.0/12", "IP-CIDR,192.168.0.0/16", "IP-CIDR,10.0.0.0/8", "IP-CIDR,17.0.0.0/8", "IP-CIDR,100.64.0.0/10",
  "IP-CIDR,224.0.0.0/4", "IP-CIDR6,fe80::/10",
  // Whatever else is in China, by where its address is
  "GEOIP,CN",
];

/** Block Ads & Trackers: broad keywords, so it is served after the subscription's own rules — what a rule before it
 *  claims is not touched. */
export const BLOCK_TEMPLATE: readonly string[] = [
  "DOMAIN-KEYWORD,admarvel", "DOMAIN-KEYWORD,admaster", "DOMAIN-KEYWORD,adsage", "DOMAIN-KEYWORD,adsmogo", "DOMAIN-KEYWORD,adsrvmedia",
  "DOMAIN-KEYWORD,adwords", "DOMAIN-KEYWORD,adservice", "DOMAIN-SUFFIX,appsflyer.com", "DOMAIN-KEYWORD,domob", "DOMAIN-SUFFIX,doubleclick.net",
  "DOMAIN-KEYWORD,duomeng", "DOMAIN-KEYWORD,dwtrack", "DOMAIN-KEYWORD,guanggao", "DOMAIN-KEYWORD,lianmeng", "DOMAIN-SUFFIX,mmstat.com",
  "DOMAIN-KEYWORD,mopub", "DOMAIN-KEYWORD,omgmta", "DOMAIN-KEYWORD,openx", "DOMAIN-KEYWORD,partnerad", "DOMAIN-KEYWORD,pingfore",
  "DOMAIN-KEYWORD,supersonicads", "DOMAIN-KEYWORD,uedas", "DOMAIN-KEYWORD,umeng", "DOMAIN-KEYWORD,usage", "DOMAIN-SUFFIX,vungle.com",
  "DOMAIN-KEYWORD,wlmonitor", "DOMAIN-KEYWORD,zjtoolbar",
];

/** DNS (§7.8): what goes under `dns:` in the subscription handed over, in place of its own, when the DNS template is
 *  on — the user's own section of 2026-10-08 with its notes, less two names that were that user's own. Names in China,
 *  Apple's and ByteDance's are resolved by DNS servers in China (so a nearby CDN answers); everything else over HTTPS
 *  abroad, following the rules; Claude's names take only the answer from abroad; the listed names get their real
 *  addresses instead of made-up ones. */
export const DNS_TEMPLATE = `enable: true
listen: 0.0.0.0:53
ipv6: false
respect-rules: true
enhanced-mode: fake-ip
fake-ip-range: 198.18.0.1/16
nameserver:
  - https://1.1.1.1/dns-query
  - https://dns.google/dns-query
# 国内域名用国内 DNS 解析,避免拿到海外 CDN IP 导致直连很慢
nameserver-policy:
  "geosite:cn,private":
    - 223.5.5.5
    - 119.29.29.29
  "+.doubao.com,+.volces.com,+.volcengine.com,+.byteimg.com,+.bytedanceapi.com,+.bytedance.com,+.byted-static.com,+.pstatp.com,+.snssdk.com":
    - 223.5.5.5
    - 119.29.29.29
  # Apple 下载/更新/iCloud 用国内 DNS,拿到国内 CDN 节点
  "+.apple.com,+.mzstatic.com,+.aaplimg.com,+.cdn-apple.com,+.apple-cloudkit.com,+.apple-mapkit.com,+.apple-dns.net,+.icloud.com,+.icloud-content.com,+.me.com":
    - 223.5.5.5
    - 119.29.29.29
fallback:
  - https://cloudflare-dns.com/dns-query
  - https://dns.google/dns-query
  - tls://1.1.1.1:853
  - tls://dns.google:853
fallback-filter:
  geoip: false
  ipcidr:
    - 240.0.0.0/4
  domain:
    - +.anthropic.com
    - +.claude.ai
    - +.claude.com
    - +.claudeusercontent.com
default-nameserver:
  - 223.5.5.5
  - 119.29.29.29
proxy-server-nameserver:
  - 223.5.5.5
  - 119.29.29.29
fake-ip-filter:
  - "*.lan"
  - "*.localdomain"
  - "*.local"
  - "*.home.arpa"
  - "localhost.ptlogin2.qq.com"
  - "+.msftconnecttest.com"
  - "+.msftncsi.com"
  - "connectivitycheck.gstatic.com"
  - "detectportal.firefox.com"
  - "localhost"
  - "localhost.work.weixin.qq.com"
  - "+.baidu.com"
  - "+.bing.com"
  - "+.bilibili.com"
  - "+.bilivideo.com"
  - "+.bilivideo.cn"
  - "+.biliapi.com"
  - "+.biliapi.net"
  - "+.hdslb.com"
  - "+.biliimg.com"
  - "+.qq.com"
  - "+.tencent.com"
  - "+.gtimg.com"
  - "+.qpic.cn"
  - "+.tenpay.com"
  - "+.weixin.qq.com"
  - "+.wx.qq.com"
  - "+.wechat.com"
  - "+.xiaohongshu.com"
  - "+.xhscdn.com"
  - "+.xiaohongshu.cn"
  - "+.apple.com"
  - "+.apple-cloudkit.com"
  - "+.apple-mapkit.com"
  - "+.apple-dns.net"
  - "+.icloud.com"
  - "+.icloud-content.com"
  - "+.me.com"
  - "+.mzstatic.com"
  - "+.itunes.apple.com"
  - "+.cdn-apple.com"
  - "+.aaplimg.com"
  - "+.douyin.com"
  - "+.douyinpic.com"
  - "+.douyincdn.com"
  - "+.douyinvod.com"
  - "+.toutiao.com"
  - "+.toutiaoimg.com"
  - "+.toutiaoimg.cn"
  - "+.toutiaovod.com"
  - "+.bytedance.com"
  - "+.byteimg.com"
  - "+.bytcdn.com"
  - "+.bytegoofy.com"
  - "+.byted-static.com"
  - "+.snssdk.com"
  - "+.amemv.com"
  - "+.ixigua.com"
  - "+.pstatp.com"
  - "+.taobao.com"
  - "+.tmall.com"
  - "+.alicdn.com"
  - "+.aliyuncs.com"
  - "+.alibabacloud.com"
  - "+.alipay.com"
  - "+.alipayobjects.com"
  - "+.alibaba.com"
  - "+.1688.com"
  - "+.mmstat.com"
  - "+.tbcache.com"
  - "+.cainiao.com"
  - "+.dingtalk.com"
  - "+.jd.com"
  - "+.jd.hk"
  - "+.360buyimg.com"
  - "+.jdcloud.com"
  - "+.jcloudcdn.com"
  - "+.pinduoduo.com"
  - "+.yangkeduo.com"
  - "+.pddpic.com"
  - "+.meituan.com"
  - "+.meituan.net"
  - "+.dianping.com"
  - "+.dpfile.com"
  - "+.163.com"
  - "+.126.com"
  - "+.netease.com"
  - "+.neteasemusic.com"
  - "+.music.126.net"
  - "+.ydstatic.com"
  - "+.nosdn.127.net"
  - "+.ye.163.com"
`;
