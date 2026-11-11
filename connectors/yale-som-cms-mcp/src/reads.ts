import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { CmsBrowser } from './browser.js';
import { areas, CMS_ORIGIN, CmsError, TIMEZONE, type Area, type CmsRecord, type FieldValue, type FormField, type JsonRecord, type ReadRequest, type ReadResult } from './types.js';

export const CMS_ROUTES: Record<Area, string> = {
  dashboard: '/dashboard/', jobs: '/jobPostings#/jobPostings/index?viewId=1',
  applications: '/jobPostings#/jobPostings/applied-job-postings',
  interviews: '/school-offices/calendar?tab=myCalendar', events: '/events#/events/view/1',
  appointments: '/appointments/', calendar: '/school-offices/calendar',
  employers: '/Companies#/Companies', contacts: '/Companies#/Contacts',
  targets: '/Companies#/target-companies-contacts', tasks: '/tasks/', activity: '/Companies/ActivityStream',
  profile: '/students/profile?tab=home', documents: '/application-documents/student-home',
  resume_books: '/ResumeBooks#/resume-books', resources: '/resource-library/',
  analytics: '/job-analytics/internships', offices: '/school-offices',
  saved_searches: '/jobPostings#/jobPostings/index?viewId=1', settings: '/account/settings',
  outcomes: '/students/profile?tab=home',
};
const MAIN = '[role="main"],main';
const numeric = (id: string) => /^\d+$/.test(id);
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameOrigin = (href: string, base = CMS_ORIGIN) => {
  const url = new URL(href, base);
  if (url.origin !== CMS_ORIGIN || url.username || url.password) throw new CmsError('external_link', 'This action belongs to another site. Open its source link yourself.');
  return url;
};
export function cmsRoute(area: Area, id?: string, view?: string): string {
  let route = CMS_ROUTES[area];
  if (!route) throw new CmsError('unsupported_area', 'Unknown CMS area.');
  if (area === 'saved_searches' && view && ['jobs','events','employers','contacts'].includes(view)) route = CMS_ROUTES[view as Area];
  if (area === 'jobs' && view === 'home') route = '/jobPostings#/jobPostings/home';
  if (area === 'events' && view === 'home') route = '/events#/events/home';
  if (area === 'profile' && view === 'profile') route = '/students/profile?tab=profile';
  if (area === 'targets' && ['companies','contacts'].includes(view || '')) route += `?tab=${view}`;
  if (area === 'settings' && ['general','integrations','notifications'].includes(view || '')) route += `#?tab=${view}`;
  if (!id) return CMS_ORIGIN + route;
  const raw = id.replace(/^(company|contact|folder|file):/, '');
  if (!numeric(raw)) throw new CmsError('invalid_id', 'Use the exact record ID returned by a CMS read tool.');
  switch (area) {
    case 'jobs': case 'applications': return `${CMS_ORIGIN}/jobPostings#/jobPostings/${raw}`;
    case 'events': return `${CMS_ORIGIN}/events#/events/${raw}`;
    case 'employers': return `${CMS_ORIGIN}/Companies#/Companies/${raw}`;
    case 'contacts': return `${CMS_ORIGIN}/Companies#/Contacts/${raw}`;
    case 'resume_books': return `${CMS_ORIGIN}/ResumeBooks#/resume-books/${raw}`;
    case 'resources': if (!id.startsWith('file:')) return `${CMS_ORIGIN}/resource-library/${raw}`; break;
  }
  // Some records are in a list or read-only modal rather than their own URL.
  return CMS_ORIGIN + route;
}

/** Stable field names and labels; never return credential or anti-forgery fields. */
export async function extractReadFields(page: Page, scope = MAIN): Promise<FormField[]> {
  return page.locator(scope).first().evaluate(root => {
    const fields: FormField[] = [];
    const visible = (e: Element) => !!(e as HTMLElement).getBoundingClientRect().width && !e.closest('[hidden],.ng-hide');
    for (const element of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) {
      if (['hidden','password','file','submit','button'].includes(element.type) || !visible(element)) continue;
      const owner = element.closest('tt-input');
      const label = element.getAttribute('aria-label') || [...(element.labels || [])].map(x=>x.textContent || '').join(' ') || owner?.getAttribute('label') || element.getAttribute('placeholder') || element.name || '';
      const name = element.name || owner?.getAttribute('name') || label || (!/^input-[a-z0-9]+-/i.test(element.id) ? element.id : '');
      if (!name || /password|token|csrf|secret|passport/i.test(name + ' ' + label) || /^(un)?favorited$/i.test(label)) continue;
      const value = element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type) ? element.checked : element.value;
      fields.push({ id: name.trim(), label: label.replace(/\s+/g,' ').trim(), type: element.type, required: element.required,
        value, read_only: element.disabled || ('readOnly' in element && element.readOnly),
        ...(element instanceof HTMLSelectElement ? { options: [...element.options].map(x=>({value:x.value,label:x.textContent?.trim() || '',disabled:x.disabled})) } : {}) });
    }
    return fields;
  });
}

type Snapshot = { title:string; text:string; links:{name:string;url:string;text:string;cells:string[];favorite?:boolean}[]; tableRows:{text:string;cells:string[]}[]; models:JsonRecord[]; filters:JsonRecord[]; total?:number; headings:string[]; context:JsonRecord; };
type Cursor = { account:string; request:string; offset:number; expires:number; };

export class CmsReads {
  private readonly cursors = new Map<string, Cursor>();
  private readonly knownLinks = new Map<string, {url:string;name:string}>();
  private readonly knownRecords = new Map<string,CmsRecord>();
  private account?:string;
  constructor(readonly browser: CmsBrowser) {}

  async capabilities(): Promise<JsonRecord> {
    const page = await this.navigate('dashboard');
    const identity = await this.browser.identity();
    const navigation = await page.locator('nav,[role=navigation]').first().evaluate(root => [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a=>({name:(a.textContent||'').replace(/\s+/g,' ').trim(),url:a.href}))).catch(()=>[]);
    return { account:identity.name, account_id:identity.account_id, origin:CMS_ORIGIN, timezone:TIMEZONE,
      areas: areas.map(area=>({area,url:CMS_ORIGIN+CMS_ROUTES[area],read:true})), navigation,
      views:{jobs:['search','home'],events:['search','home'],targets:['companies','contacts'],profile:['home','profile'],settings:['general','integrations','notifications'],saved_searches:['jobs','events','employers','contacts']},
      filters:'Use the filter names and options returned by read results. Filters operate the site search controls. Unavailable or unrecognized controls return explicit errors.',
      authentication:'Complete sign-in yourself with login; the dedicated saved profile is used headlessly for subsequent tools.',
      limitations:['Third-party employer applications require opening the external link.','Interview availability comes from My Interview Availability; interview scheduling actions depend on the account and job.'] };
  }

  async navigate(area: Area, id?: string, view?: string): Promise<Page> {
    const page = await this.browser.page();
    await page.goto(cmsRoute(area,id,view), {waitUntil:'domcontentloaded'});
    await this.settled(page);
    const currentIdentity=await this.browser.identity();
    if(this.account!==currentIdentity.key){this.knownLinks.clear();this.knownRecords.clear();this.cursors.clear();this.account=currentIdentity.key;}
    if (area === 'saved_searches') {
      const menu = page.locator(MAIN).getByRole('button',{name:/^My Saved Searches/}).first();
      if (!await menu.count()) throw new CmsError('feature_unavailable','Saved searches are not exposed for this account or selected area.');
      await menu.evaluate(e=>(e as HTMLElement).click());
      await this.settled(page);
    }
    if (id && area === 'appointments') {
      const known=this.knownRecords.get(`${area}:${id}`);
      if(typeof known?.start==='string'){await page.evaluate(start=>{const e=document.querySelector('tt-calendar');const c=e&&(window as any).angular?.element(e).controller('ttCalendar');if(c?.goToDate)c.goToDate(start);},known.start);await this.settled(page);}
      const opened = await page.evaluate(id => {
        const element = document.querySelector('tt-appointment-list');
        const ctrl = element && (window as any).angular?.element(element).controller('ttAppointmentList');
        const matches = ctrl?.calendarEvents?.filter((x:any)=>String(x.EntityId) === id) || [];
        if (matches.length !== 1 || typeof ctrl.showDetails !== 'function') return false;
        ctrl.showDetails(matches[0]);
        return true;
      },id);
      if (!opened) throw new CmsError('record_not_found','That appointment/block is not in the current calendar range. Read the desired range first and use its exact ID.');
      await page.locator('[role=dialog],.modal-dialog,.slideout').filter({visible:true}).first().waitFor({state:'visible',timeout:10_000}).catch(()=>{});
      await this.settled(page);
    }
    if (view && !['home','profile','companies','contacts','general','integrations','notifications','search','jobs','events','employers'].includes(view)) {
      const tab = page.locator(MAIN).getByRole('tab',{name:view,exact:true}).or(page.locator(MAIN).getByRole('link',{name:view,exact:true}));
      if (await tab.count() !== 1) throw new CmsError('unsupported_view','The requested view is not uniquely available on this CMS page.',{view});
      await tab.evaluate(e=>(e as HTMLElement).click());
      await this.settled(page);
    }
    if(id&&['tasks','targets','activity','documents'].includes(area)){
      let found=false;
      for(let attempt=0;attempt<20;attempt++){const items=this.records(area,await this.snapshot(page));if(items.some(r=>r.id===id)){found=true;break;}if(!await this.more(page))break;}
      if(!found)throw new CmsError('record_not_found','This record is not exposed by the current account and active filters.',{area,id});
      if(area==='activity'){await page.evaluate(id=>{const e=[...document.querySelectorAll('.activity-stream-card')].find(e=>String((window as any).ko?.dataFor(e)?.Id?.())===id);const m=e&&(window as any).ko.dataFor(e);if(m?.showViewMore?.()&&typeof m.toggle==='function')m.toggle();},id);await this.settled(page);}
    }
    return page;
  }

  private async settled(page: Page) {
    await page.locator(MAIN).first().waitFor({state:'visible',timeout:20_000}).catch(async()=>{
      if (new URL(page.url()).origin !== CMS_ORIGIN || /login|signin|sso/i.test(new URL(page.url()).pathname)) throw new CmsError('auth_required','Run login and complete sign-in in the dedicated browser.');
      throw new CmsError('page_changed','CMS did not expose the expected main content.');
    });
    await page.waitForFunction(() => {
      const root = document.querySelector('[role=main],main');
      if (!root || !(root as HTMLElement).innerText.trim()) return false;
      const angular = (window as any).angular;
      const injector=angular?.element(document.body).injector();
      if(injector?.has('$http')&&injector.get('$http').pendingRequests.some((r:any)=>/^\/?(?:api\/|https:\/\/som-yale\.12twenty\.com\/api\/)/.test(r.url)&&!/ably|tokens|last-updated|audit-log/i.test(r.url)))return false;
      for (const tag of ['tt-task-list','tt-event-list','tt-applied-job-postings','tt-company-list','tt-resource-library']) {
        const e = root.querySelector(tag); if (!e || !angular) continue;
        const name = tag.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
        const ctrl = angular.element(e).controller(name);
        if (ctrl?.isLoading || ctrl?.isQueryInProgress) return false;
      }
      return ![...root.querySelectorAll('[aria-busy=true]')].some(e=>(e as HTMLElement).getBoundingClientRect().width);
    },undefined,{timeout:20_000}).catch(()=>{throw new CmsError('page_not_ready','CMS is still loading or its layout changed. Retry the read after the page finishes.');});
    const error = await page.locator(MAIN).first().innerText();
    if (/^(Access Denied|Forbidden|Unauthorized|You do not have (?:permission|access)|Page not found)\b/i.test(error.trim()))
      throw new CmsError('permission_denied','This CMS page is not available to the authenticated account.');
  }

  private async snapshot(page: Page, detail = false, area?:Area): Promise<Snapshot> {
    const dialogs=page.locator('[role=dialog],.modal-dialog,.slideout').filter({visible:true});
    const target=area==='saved_searches'?page.locator('tt-saved-search').first():detail&&await dialogs.count()?dialogs.last():page.locator(MAIN).first();
    return target.evaluate(root => {
      const norm = (x:string) => x.replace(/\s+/g,' ').trim();
      const visible = (e:Element) => !!(e as HTMLElement).getBoundingClientRect().width && !e.closest('[hidden],.ng-hide');
      const allLinks = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).map(a=>{
        const row = a.closest('tr,[role=row],.event-row,.activity-item,.card') || a.parentElement!;
        const checkbox = row.querySelector<HTMLInputElement>('input[type=checkbox][aria-label*=favorited]');
        return {name:norm(a.textContent || a.getAttribute('aria-label') || ''),url:a.href,text:norm((row as HTMLElement).innerText || ''),cells:[...row.querySelectorAll('td,[role=cell]')].map(x=>norm((x as HTMLElement).innerText || '')),...(checkbox?{favorite:checkbox.checked}:{})};
      }).filter(x=>x.name && /^https?:/.test(x.url));
      const tableRows = [...root.querySelectorAll('tbody tr,[role=rowgroup] [role=row]')].filter(visible).map(r=>({text:norm((r as HTMLElement).innerText||''),cells:[...r.querySelectorAll('td,[role=cell]')].map(c=>norm((c as HTMLElement).innerText||''))})).filter(x=>x.text);
      const angular = (window as any).angular;
      const models:JsonRecord[] = [];
      const seen = new Set<string>();
      const fields = ['Id','EntityId','TypeId','Name','Title','Subject','Description','Status','StatusId','JobStatus','ApplicationStatus','RegistrationStatus','ApprovalStatus','CompanyId','CompanyName','ContactId','ContactName','AdviserId','AdviserName','StartTime','EndTime','start','end','Location','DueDate','Date','Email','EmailAddress','Phone','JobTitle','IsFavorite','IsRegistered','IsApplied','IsForOfficeHours','HasMaxAppointmentsReached','ApplicationDocumentTypeId','FileId','FileName','Url','Priority','PriorityId','Comments','InterviewDate','ApplicationDeadline','CreatedDate','UpdatedDate','TimeSlotId','EventTimeSlotId','ScheduleId','EventId','slotStatus','canRegisterForTimeslot','canCancelRegistration','IsAttending','IsOnWaitlist','IsTimeSlotEvent','IsUpcoming','RegistrationBeginDate','RegistrationEndDate','IsFull','IsAvailable','IsRegistered','MaxAttendees','NumRegistrations','RegistrationCount','Capacity','ActivityDate','NoteTypeName','CanEdit','CanDelete','AcademicYearId','IsWithdrawn','IsApproved','DidAttend','IsNoShow'];
      const collect = (values:any,source:string) => {
        const items = Array.isArray(values)?values:values?.Items || values?.Results;
        if (!Array.isArray(items)) return;
        for (const item of items) {
          if (!item || typeof item!=='object' || (!item.Id && !item.EntityId)) continue;
          const key=source+':'+String(item.EntityId || item.Id); if(seen.has(key))continue;seen.add(key);
          const result:JsonRecord={_source:source};
          for(const field of fields) {
            const value=item[field];
            if(typeof value==='string'||typeof value==='number'||typeof value==='boolean'||value===null) result[field]=value;
          }
          models.push(result);
        }
      };
      if(angular) for(const element of [root,...root.querySelectorAll('*')]) {
        const tag=element.tagName.toLowerCase();
        if(!tag.startsWith('tt-'))continue;
        const name=tag.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
        const ctrl=angular.element(element).controller(name); if(!ctrl)continue;
        for(const key of ['calendarEvents','appointmentCalendarEvents','tasks','jobPostings','allApplicationDocuments','applicationDocuments','companyPagedList','contactPagedList','pagedResult','pagedList','resumeBooks','items','resources','jobs','educations','timeSlots','studentTimeSlots']) collect(ctrl[key],tag);
        if(tag==='tt-saved-search')for(const group of ctrl.savedSearchGroups||[])collect(group.savedSearches,'saved_search');
        for(const key of ['event','jobPosting','company','contact','task','applicationDocument']) if(ctrl[key])collect([ctrl[key]],tag);
      }
      const ko=(window as any).ko;
      if(ko)for(const card of root.querySelectorAll('.activity-stream-card')){const model=ko.dataFor(card);if(!model)continue;const values:JsonRecord={};for(const key of fields){const v=model[key];values[key]=typeof v==='function'?v():v;}collect([values],'activity-stream-card');}
      const context:JsonRecord={};
      const safe=(value:any,depth=0):any=>{if(value===null||['string','number','boolean'].includes(typeof value))return value;if(depth>5)return undefined;if(Array.isArray(value))return value.slice(0,100).map(v=>safe(v,depth+1));if(typeof value!=='object')return undefined;return Object.fromEntries(Object.entries(value).filter(([k])=>!k.startsWith('$')&&!/token|secret|cookie|password|csrf|passport|session|^Student(?:Id|Name|Email)$/i.test(k)).slice(0,200).map(([k,v])=>[k,safe(v,depth+1)]).filter(([,v])=>v!==undefined));};
      if(angular){for(const [tag,keys]of [['tt-event-detail',['studentRegistration','studentTimeSlots','studentRegistrationLabel','scheduleDates']],['tt-time-slot-list',['eventId','currentUserTimeSlot','canCancelRegistration','canSwapTimeSlot']],['tt-job-posting-detail',['studentApplication','application','studentRegistration','applicationStatus']],['tt-calendar',['view']]] as const){const e=document.querySelector(tag);if(!e)continue;const c=angular.element(e).controller(tag.replace(/-([a-z])/g,(_,v)=>v.toUpperCase()));if(!c)continue;context[tag]=Object.fromEntries(keys.filter(k=>c[k]!==undefined).map(k=>[k,safe(c[k])]));}}
      if(angular){const e=document.querySelector('tt-event-detail');const c=e&&angular.element(e).controller('ttEventDetail');if(c?.event){const event=c.event;const slots=document.querySelector('tt-time-slot-list');const sc=slots&&angular.element(slots).controller('ttTimeSlotList');const own=sc?.currentUserTimeSlot;const slotKeys=['Id','EventTimeSlotId','EventId','ScheduleId','StartTime','EndTime','slotStatus','canRegisterForTimeslot','canCancelRegistration'];context.registration_state={event_id:event.Id,is_attending:event.IsAttending,rules:safe(event.RegistrationRules),label:c.studentRegistrationLabel,current_slot:own?Object.fromEntries(slotKeys.filter(k=>own[k]!==undefined).map(k=>[k,safe(own[k])])):null};}}
      const filterElement=root.querySelector('tt-filter');
      const filter=filterElement&&angular?.element(filterElement).controller('ttFilter');
      const filters=(filter?.availableFilters||[]).map((f:any)=>({id:f.PropertyName||f.AttributeName||f.DisplayName,label:f.DisplayName,type:f.FieldTypeId||f.TypeId,lookup_id:f.LookupId,custom_filter_type_id:f.CustomFilterTypeId}));
      const text=(root as HTMLElement).innerText;
      const totalMatch=text.match(/Results:\s*([\d,]+)/i);
      return {title:document.title,text,links:allLinks,tableRows,models,filters,context,total:totalMatch?Number(totalMatch[1].replaceAll(',','')):undefined,headings:[...root.querySelectorAll('h1,h2,h3,h4')].filter(visible).map(x=>norm(x.textContent||''))};
    });
  }

  private recordId(url: string): string | undefined {
    const u=sameOrigin(url);
    const value=u.pathname+u.hash;
    const download=value.match(/\/api\/v2\/resource-library-items\/(\d+)\/download/i);
    if(download)return `file:${download[1]}`;
    const folder=value.match(/^\/resource-library\/(\d+)(?:$|[/?#])/i);
    if(folder)return `folder:${folder[1]}`;
    const id=value.match(/(?:jobPostings|events|Companies|Contacts|resume-books|school-offices)\/(\d+)(?:$|[/?#])/i);
    return id?.[1];
  }

  private records(area: Area, snap: Snapshot, detailId?:string): CmsRecord[] {
    const found=new Map<string,CmsRecord>();
    for(const link of snap.links){
      if(area==='activity'||area==='saved_searches')continue;
      let url:URL;try{url=sameOrigin(link.url);}catch{continue;}
      const id=this.recordId(url.href);if(!id)continue;
      const normalized={id,name:link.name,url:url.href,text:link.text,columns:link.cells,...(link.favorite!==undefined?{favorite:link.favorite}:{})};
      found.set(id,normalized);this.knownLinks.set(`${area}:${id}`,{url:url.href,name:link.name});
    }
    for(const model of snap.models){
      if(area==='saved_searches'&&model._source!=='saved_search')continue;
      const id=String(model.EntityId||model.Id);
      if(!id||id==='undefined')continue;
      const existing=found.get(id);
      const name=String(model.Name||model.Title||model.Subject||model.AdviserName||model.CompanyName||model.ContactName||existing?.name||(model._source==='tt-time-slot-list'?`${model.StartTime} – ${model.EndTime}`:`${area} ${id}`));
      if(model._source==='tt-time-slot-list'&&typeof model.StartTime==='string'){model.start=/Z$|[+-]\d\d:\d\d$/.test(model.StartTime)?model.StartTime:model.StartTime+'Z';if(typeof model.EndTime==='string')model.end=/Z$|[+-]\d\d:\d\d$/.test(model.EndTime)?model.EndTime:model.EndTime+'Z';}
      const data=Object.fromEntries(Object.entries(model).filter(([key])=>!key.startsWith('_')));
      found.set(id,{...existing,id,name,...data,...(model.start?{start:model.start,end:model.end,timezone:TIMEZONE}:{}),...(area==='appointments'||model._source==='tt-time-slot-list'?{slot_id:id}:{}),...(model._source==='tt-time-slot-list'?{kind:'event_slot'}:{}),source_component:model._source});
    }
    if(!found.size && snap.tableRows.length)for(const row of snap.tableRows){
      if(/^(no |there are no)/i.test(row.text))continue;
      const id=`row:${digest(row.cells).slice(0,20)}`;
      found.set(id,{id,name:row.cells[0]||row.text,columns:row.cells,text:row.text,read_only_summary:true});
    }
    if(detailId && ['jobs','applications','events','employers','contacts','resume_books','resources','appointments'].includes(area) && !found.has(detailId)) found.set(detailId,{id:detailId,name:snap.headings[0]||snap.title,text:snap.text});
    for(const record of found.values())this.knownRecords.set(`${area}:${record.id}`,record);
    return [...found.values()];
  }

  private async applyFilters(page:Page,request:ReadRequest) {
    const root=page.locator(MAIN).first();
    if(request.query !== undefined){
      const search=root.locator('input[aria-label="Employer, Job Title, or Keyword"],input[aria-label="Employer, Event Name, or Keyword"],input[aria-label="Employer Name"],input[aria-label="Contact Name or Email Address"],input[aria-label="Search by subject or description"],input[aria-label="Folder or Resource Name"],input[placeholder="Search resume book title"],input[aria-label="Search by Employer or Contact"]');
      if(await search.count()!==1)throw new CmsError('unsupported_filter','This page does not expose a unique supported search box.',{area:request.area});
      await search.fill(request.query);
      const button=root.getByRole('button',{name:/^(Search|Get Results)$/}).first();
      if(await button.count())await button.evaluate(e=>(e as HTMLElement).click());else await search.press('Enter');
      await this.settled(page);
    }
    for(const [key,value] of Object.entries(request.filters||{})){
      // These are search form controls only, never record-level checkboxes/favorites.
      const control=root.locator('select').filter({visible:true});
      const selects=await control.evaluateAll((elements,key)=>elements.filter(e=>[e.getAttribute('name'),e.id,...[...((e as HTMLSelectElement).labels||[])].map(l=>l.textContent?.trim())].includes(key)).map(e=>({name:e.getAttribute('name'),id:e.id})),key);
      if(selects.length===1){
        const select=selects[0].name?root.locator(`select[name=${JSON.stringify(selects[0].name)}]`):root.locator(`select[id=${JSON.stringify(selects[0].id)}]`);
        const values=Array.isArray(value)?value.map(String):[String(value)];
        const options=await select.locator('option').evaluateAll(options=>options.map(o=>({value:(o as HTMLOptionElement).value,label:o.textContent?.trim()})));
        const selected=values.map(v=>{const item=options.find(o=>o.value===v||o.label===v);if(!item)throw new CmsError('invalid_filter_value','Choose an available filter option.',{filter:key,options});return item.value;});
        await select.selectOption(selected);
        const submit=root.getByRole('button',{name:'Get Results',exact:true});if(await submit.count())await submit.evaluate(e=>(e as HTMLElement).click());
        await this.settled(page);continue;
      }
      const filter=root.locator('tt-selected-filter').filter({has:page.locator('.filter-label',{hasText:new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`,'i')})});
      if(await filter.count()!==1)throw new CmsError('unsupported_filter','This filter is not currently exposed. Use a filter label returned by this page.',{filter:key});
      await filter.locator('button.selected-filter__toggle').evaluate(e=>(e as HTMLElement).click());
      const checkboxes=filter.getByRole('checkbox');
      if(await checkboxes.count()){
        const wanted=Array.isArray(value)?value.map(String):typeof value==='boolean'?[value?'Yes':'No']:[String(value)];
        const labels=await checkboxes.evaluateAll(elements=>elements.map(e=>(e.getAttribute('aria-label')||[...((e as HTMLInputElement).labels||[])].map(l=>l.textContent||'').join(' ')).replace(/\s+/g,' ').trim()));
        for(const item of wanted)if(!labels.includes(item))throw new CmsError('invalid_filter_value','Choose an exposed filter option.',{filter:key,options:labels.filter(l=>l!=='Select All')});
        for(let i=0;i<labels.length;i++){if(labels[i]==='Select All')continue;await checkboxes.nth(i).setChecked(wanted.includes(labels[i]));}
      }else{
        const inputs=filter.locator('input:not([type=hidden]):not([type=search]),textarea').filter({visible:true});
        if(await inputs.count()!==1||Array.isArray(value))throw new CmsError('unsupported_filter','This compound filter needs its dedicated CMS control; no values were submitted.',{filter:key});
        await inputs.fill(String(value));await inputs.press('Tab');
      }
      const apply=filter.getByRole('button',{name:/^(Apply|Update|Done)$/});if(await apply.count()===1)await apply.evaluate(e=>(e as HTMLElement).click());
      const toggle=filter.locator('button.selected-filter__toggle');if(await toggle.getAttribute('aria-expanded')==='true')await toggle.evaluate(e=>(e as HTMLElement).click());
      await this.settled(page);
    }
    if(request.start || request.end){
      if(request.area==='activity'){
        for(const [selector,date] of [['#fromDate',request.start],['#toDate',request.end]] as const)if(date){const parts=new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));await root.locator(selector).fill(parts);await root.locator(selector).press('Tab');}
        await this.settled(page);
      }else if(['appointments','calendar','interviews','events'].includes(request.area)){
        // The actual calendar component is the same control used by its date picker.
        const changed=await page.evaluate(({start,end})=>{
          const e=document.querySelector('tt-calendar');const ctrl=e&&(window as any).angular?.element(e).controller('ttCalendar');
          if(!ctrl||typeof ctrl.goToDate!=='function')return false;
          const from=start||ctrl.view?.listViewDateRange?.Start||ctrl.view?.activeStart;
          if(!from||end&&Date.parse(end)<=Date.parse(from))return false;
          ctrl.goToDate(from);return true;
        },{start:request.start,end:request.end});
        if(!changed)throw new CmsError('unsupported_date_range','The CMS calendar does not expose a verified date navigator. Use its current date range; dates were not silently ignored.');
        await this.settled(page);
      }else throw new CmsError('unsupported_date_range','This CMS area does not expose a supported date-range filter.');
    }
  }

  private async more(page:Page,until?:string):Promise<boolean>{
    const root=page.locator(MAIN).first();
    let next=root.getByRole('button',{name:/^Load more results/i}).filter({visible:true});
    if(!await next.count())next=root.locator('.pagination a[aria-label="Next"],.pagination li:not(.disabled) a[rel=next],.pagination li:not(.disabled) a[data-bind="click: clickNext"],a[aria-label="Next page"]');
    if(!await next.count()&&until){const end=await page.evaluate(()=>{const e=document.querySelector('tt-calendar');const c=e&&(window as any).angular?.element(e).controller('ttCalendar');return c?.view?.listViewDateRange?.End||c?.view?.activeEnd;});if(end&&Date.parse(end)<Date.parse(until))next=root.getByRole('button',{name:'next',exact:true});}
    if(await next.count()!==1 || await next.isDisabled() || await next.getAttribute('aria-disabled')==='true')return false;
    const before=await root.innerText();
    await next.evaluate(e=>(e as HTMLElement).click());
    await page.waitForFunction(({before})=>(document.querySelector('[role=main],main') as HTMLElement)?.innerText!==before,{before},{timeout:15_000}).catch(()=>{throw new CmsError('pagination_failed','CMS did not advance the result page. No complete-results claim was made.');});
    await this.settled(page);return true;
  }

  async read(input:ReadRequest):Promise<ReadResult>{
    const page=await this.navigate(input.area,input.id,input.view);
    const identity=await this.browser.identity();
    const signature=digest({...input,cursor:undefined,limit:undefined});
    let offset=0;
    if(input.cursor){const state=this.cursors.get(input.cursor);if(!state||state.expires<Date.now()||state.account!==identity.key||state.request!==signature)throw new CmsError('invalid_cursor','This continuation expired or belongs to another account/query. Start a fresh read.');offset=state.offset;}
    await this.applyFilters(page,input);
    let snap=await this.snapshot(page,!!input.id,input.area);
    let records=this.records(input.area,snap,input.id);
    const collected=new Map(records.map(r=>[r.id,r]));
    let loadedMore=0;
    const inRange=(r:CmsRecord)=>!r.start||(!input.start||Date.parse(String(r.start))>=Date.parse(input.start))&&(!input.end||Date.parse(String(r.start))<Date.parse(input.end));
    while([...collected.values()].filter(inRange).length<offset+input.limit+1 && !input.id && loadedMore<20){
      if(!await this.more(page,input.end))break;
      loadedMore++;snap=await this.snapshot(page,false,input.area);records=this.records(input.area,snap);for(const record of records)collected.set(record.id,record);
    }
    records=[...collected.values()];
    if(input.id&&!['jobs','applications','events','employers','contacts','resume_books','resources','appointments'].includes(input.area)){
      const match=records.find(r=>r.id===input.id);
      if(!match)throw new CmsError('record_not_found','The requested record is not present in this account view.',{area:input.area,id:input.id});
      records=[match];offset=0;
    }
    if(input.start||input.end)records=records.filter(inRange);
    const availableMore=records.length>offset+input.limit || (!!snap.total&&snap.total>records.length) || loadedMore===20;
    let cursor:string|undefined;
    if(availableMore){cursor=randomUUID();this.cursors.set(cursor,{account:identity.key,request:signature,offset:offset+input.limit,expires:Date.now()+600_000});}
    for(const [key,state]of this.cursors)if(state.expires<Date.now())this.cursors.delete(key);
    const selected=records.slice(offset,offset+input.limit);
    const text=input.id||!records.length?snap.text.slice(0,60000):selected.map(r=>String(r.text||r.name)).join('\n\n').slice(0,60000);
    return {area:input.area,url:page.url(),title:snap.title,timezone:TIMEZONE,text,records:selected,fields:await extractReadFields(page),filters:snap.filters,
      headings:snap.headings,context:snap.context,...(snap.context.registration_state?{registration_state:snap.context.registration_state}:{}),total:snap.total,loaded_records:records.length,...(cursor?{next_cursor:cursor,truncated:true}:{}),
      ...(input.area==='interviews'?{view_description:'My Interview Availability and personal calendar; job-specific interview status is shown under applications.'}:{}),
      ...(input.area==='saved_searches'?{view_description:`Saved search menu for ${input.view||'jobs'}`}:{})};
  }

  async recordLocator(area:Area,id:string):Promise<Locator>{
    const page=await this.browser.page();
    const root=page.locator(MAIN).first();
    if(area==='activity'){const marked=await page.evaluate(id=>{const found=[...document.querySelectorAll('.activity-stream-card')].filter(e=>String((window as any).ko?.dataFor(e)?.Id?.())===id);if(found.length!==1)return false;found[0].setAttribute('data-laplace-record-id',id);return true;},id);if(marked)return root.locator(`[data-laplace-record-id=${JSON.stringify(id)}]`);}
    const known=this.knownLinks.get(`${area}:${id}`);
    if(known){const links=root.locator('a').filter({hasText:known.name});const hrefs=await links.evaluateAll(es=>es.map(e=>(e as HTMLAnchorElement).href));const index=hrefs.findIndex(h=>h===known.url);if(index>=0)return links.nth(index).locator('xpath=ancestor-or-self::*[self::tr or @role="row"][1]');}
    const candidate=root.locator(`[data-id=${JSON.stringify(id)}],[data-record-id=${JSON.stringify(id)}]`);
    if(await candidate.count()===1)return candidate;
    throw new CmsError('record_not_found','No unambiguous rendered element is bound to this record ID. Read the list again.');
  }

  async download(input:{area:Area;id:string;filename?:string}):Promise<JsonRecord>{
    if(!['resources','documents'].includes(input.area))throw new CmsError('unsupported_download','Download a resource or application document returned by its read tool.');
    const identity=await this.browser.identity();
    if(this.account!==identity.key)throw new CmsError('account_changed','Read the file list again with the current account before downloading.');
    const known=this.knownLinks.get(`${input.area}:${input.id}`);
    if(!known)throw new CmsError('record_not_found','Read the document/resource list first, then use its exact file ID.');
    let url=sameOrigin(known.url);
    if(input.area==='resources'&&!/^\/api\/v2\/resource-library-items\/\d+\/download$/i.test(url.pathname))throw new CmsError('not_a_file','This resource is a folder or external link. Open/read it to find a downloadable file.');
    if(input.area==='documents'&&!/\/application-documents\/\d+\/(?:download|file)/i.test(url.pathname))throw new CmsError('unsupported_download','CMS did not expose a verified application-document download link.');
    const page=await this.browser.page();
    let response;
    for(let redirects=0;redirects<5;redirects++){
      response=await page.context().request.get(url.href,{maxRedirects:0,timeout:30_000});
      if(response.status()>=300&&response.status()<400){const location=response.headers().location;if(!location)throw new CmsError('download_failed','Download redirect had no destination.');url=sameOrigin(location,url.href);continue;}break;
    }
    if(!response||!response.ok())throw new CmsError(response?.status()===401?'auth_required':'download_failed','CMS did not return a downloadable file.');
    const type=response.headers()['content-type']||'';
    if(/text\/html|application\/json/i.test(type))throw new CmsError('download_failed','CMS returned a page or error document instead of file bytes.');
    const length=Number(response.headers()['content-length']||0);if(length>100*1024*1024)throw new CmsError('file_too_large','This file exceeds the 100 MiB download limit.');
    const data=await response.body();if(data.length>100*1024*1024)throw new CmsError('file_too_large','This file exceeds the 100 MiB download limit.');
    if((await this.browser.identity()).key!==identity.key)throw new CmsError('account_changed','The CMS account changed during the download.');
    const suggested=response.headers()['content-disposition']?.match(/filename="?([^";]+)/i)?.[1]||known.name;
    const filename=input.filename||`${randomUUID().slice(0,8)}-${suggested.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}`;
    if(filename!==basename(filename)||/[<>:"/\\|?*\x00-\x1f]/.test(filename)||/[. ]$/.test(filename)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)||!filename)throw new CmsError('invalid_filename','Use a plain filename without directories or reserved characters.');
    await mkdir(this.browser.downloadsDir,{recursive:true,mode:0o700});
    const destination=join(await realpath(this.browser.downloadsDir),filename);
    let file;try{file=await open(destination,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new CmsError('file_exists','The destination already exists. Choose another filename.');throw error;}
    try{await file.writeFile(data);}catch(error){await file.close();await unlink(destination).catch(()=>{});throw error;}await file.close();
    return {path:resolve(destination),filename,bytes:data.length,content_type:type,sha256:createHash('sha256').update(data).digest('hex'),source_url:known.url};
  }
}
