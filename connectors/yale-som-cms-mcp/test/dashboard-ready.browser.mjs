import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { CmsReads } from "../dist/reads.js";

test("dashboard waits for API work on its actual Angular root before extracting recommendations", async () => {
  const chrome = await chromium.launch({ channel: "chrome", headless: true });
  const page = await chrome.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body class=\"logged-in-user\"><main role=\"main\"><h1>Career dashboard</h1><div id=\"recommendations\"></div></main><script>\nconst http={pendingRequests:[{url:'/api/internal/jobs'},{url:'/api/v2/Events/post-query'}]};\nwindow.angular={element(el){return {injector(){return el===document.body?undefined:{has(name){return name==='$http'},get(){return http}}},controller(){return undefined}}}};\nsetTimeout(()=>{document.getElementById('recommendations').textContent='Deferred recommendation';http.pendingRequests=[];},350);\n</script>" }));
    const reads = new CmsReads({
      async page(){return page},
      async identity(){return {key:"fixture",account_id:"fixture",name:"Fixture student"}},
    });
    const data = await reads.read({area:"dashboard",limit:25});
    assert.match(data.text, /Deferred recommendation/);
    assert.equal(await page.evaluate(()=>window.angular.element(document.querySelector("main")).injector().get("$http").pendingRequests.length),0);
  } finally { await chrome.close(); }
});
