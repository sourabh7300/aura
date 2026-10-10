const http=require("http"),fs=require("fs"),path=require("path"),url=require("url");
const ROOT=path.join(__dirname,"..");
const TYPES={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon"};
http.createServer((req,res)=>{
  let p=decodeURIComponent(url.parse(req.url).pathname);
  if(p==="/")p="/";
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)){res.writeHead(403);return res.end("no")}
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404,{"Content-Type":"text/plain"});return res.end("404 "+p)}
    res.writeHead(200,{"Content-Type":TYPES[path.extname(f).toLowerCase()]||"application/octet-stream","Cache-Control":"no-store"});
    res.end(d);
  });
}).listen(49986,"127.0.0.1",()=>console.log("up on 49986"));