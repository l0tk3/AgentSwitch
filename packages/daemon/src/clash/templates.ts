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
