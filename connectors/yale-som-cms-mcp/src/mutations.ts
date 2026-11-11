import type { Locator, Page } from "playwright-core";
import { CmsBrowser } from "./browser.js";
import { CmsReads } from "./reads.js";
import { clickNamed, fieldLocator, fillFields, formScope, inspectFields, validateFields } from "./forms.js";
import { CMS_ORIGIN, TIMEZONE, CmsError, type Area, type Change, type Effect, type FormResult, type MutationResult, type Operation, type Prepared, type ReadResult, type RecordEffect } from "./types.js";

const documents=["Resumes","Cover Letters","Transcripts","Recommendation Letters","Writing Samples","Others","Urls"];
const outcomes=["Accepted Job","Received Job","Declined Job","Sponsored Job","Own Venture","Seeking Employment","Continuing Education","Postponing job search","Not seeking for other reasons"];
const sections=["General","Preferences","Summary"];
const reserved=["_section","_document_type","_outcome","_favorite","_target_type"];
const deletion=/_(delete|remove|withdraw|cancel)$/;
const areas:Record<Operation,readonly Area[]>={
 favorite_set:["jobs","events","employers","contacts"],target_add:["targets"],target_update:["targets"],target_remove:["targets"],
 task_create:["tasks"],task_update:["tasks"],task_complete:["tasks"],task_delete:["tasks"],
 saved_search_create:["jobs","events","employers","contacts","saved_searches"],saved_search_update:["jobs","events","employers","contacts","saved_searches"],saved_search_delete:["jobs","events","employers","contacts","saved_searches"],
 event_register:["events"],event_cancel:["events"],appointment_book:["appointments"],appointment_cancel:["appointments"],
 interview_book:["interviews"],interview_cancel:["interviews"],application_submit:["jobs","applications"],application_withdraw:["jobs","applications"],
 document_upload:["documents"],document_update:["documents"],document_delete:["documents"],resume_book_submit:["resume_books"],resume_book_withdraw:["resume_books"],
 profile_update:["profile"],profile_image_update:["profile"],education_create:["profile"],education_update:["profile"],education_delete:["profile"],
 experience_create:["profile"],experience_update:["profile"],experience_delete:["profile"],outcome_create:["outcomes"],outcome_update:["outcomes"],outcome_delete:["outcomes"],
 contact_create:["contacts"],contact_update:["contacts"],contact_delete:["contacts"],activity_create:["activity"],activity_update:["activity"],activity_delete:["activity"],settings_update:["settings"]
};
export const mutationAreas=areas;
const exact=(label:string)=>new RegExp("^"+label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"$","i");
const clean=(s:string)=>s.replace(/\s+/g," ").trim();
type OpenForm={page:Page;scope:Locator;form:FormResult;final:RegExp;before:ReadResult;favorite?:Locator;deleteControl?:Locator};
export class CmsMutations {
 constructor(readonly browser:CmsBrowser,readonly reads:CmsReads){}
 private validate(change:Change) {
  if(!areas[change.operation].includes(change.area))throw new CmsError("invalid_operation","This operation is not available for the selected CMS area.");
  if(change.fields._section!==undefined&&!sections.includes(String(change.fields._section)))throw new CmsError("invalid_field","Choose General, Preferences or Summary.");
  if(change.fields._document_type!==undefined&&!documents.includes(String(change.fields._document_type)))throw new CmsError("invalid_field","Choose a document category returned by CMS.");
  if(change.fields._outcome!==undefined&&!outcomes.includes(String(change.fields._outcome)))throw new CmsError("invalid_field","Choose a CMS employment status.");
  if(change.fields._target_type!==undefined&&!["employers","contacts"].includes(String(change.fields._target_type)))throw new CmsError("invalid_field","Target type must be employers or contacts.");
  if(!/_(create|upload)$/.test(change.operation)&&!["profile_update","profile_image_update","settings_update","saved_search_create"].includes(change.operation)&&!change.target_id)
   throw new CmsError("target_required","Use the exact record ID from the corresponding CMS read tool.");
 }
 private async control(scope:Locator,pattern:RegExp):Promise<Locator> {
  const nodes=scope.locator("button,a,[role=button],input[type=submit]");const found:Locator[]=[];
  for(let i=0;i<await nodes.count();i++){
   const node=nodes.nth(i); if(!await node.isVisible())continue;
   const name=await node.evaluate(e=>((e.getAttribute("aria-label")||e.textContent||(e as HTMLInputElement).value||"")+" "+[...e.querySelectorAll("[aria-label]")].map(x=>x.getAttribute("aria-label")).join(" ")).replace(/\s+/g," ").trim());
   if(pattern.test(name))found.push(node);
  }
  if(found.length!==1)throw new CmsError("action_unavailable","CMS does not expose one permitted action for this record.",{action:pattern.source,count:found.length});
  return found[0];
 }
 private async openButton(scope:Locator,pattern:RegExp) {
  const node=await this.control(scope,pattern);
  if(await node.isDisabled())throw new CmsError("action_unavailable","CMS has disabled this action.");
  await node.evaluate(e=>(e as HTMLElement).click());
 }
 private async waitForm(page:Page) {
  await page.waitForFunction(()=>[...document.querySelectorAll(".modal,[role=dialog],.slideout,tt-form-slideout")].some(e=>e.getClientRects().length)||!!document.querySelector('[role=main] form input:not([type=hidden]),[role=main] input[name^="Job."]'),null,{timeout:10000}).catch(()=>{});
  return formScope(page);
 }
 private async recordScope(page:Page,id:string,area:Area):Promise<Locator>{
  try {
   const exactRecord=await this.reads.recordLocator(area,id);
   if(await exactRecord.count()===1&&await exactRecord.isVisible())return exactRecord;
  }catch(error){if(!(error instanceof CmsError))throw error;}
  const url=new URL(page.url());
  if((url.pathname+url.hash).split(/[\\/?#=&]/).includes(id))return formScope(page);
  throw new CmsError("record_unavailable","CMS did not expose one exact record container for this account.",{id});
 }
 private async registrationState(page:Page,change:Change) {
  return page.evaluate(({id,slot})=>{
   const el=document.querySelector('tt-event-detail');
   const c=el&&(window as any).angular?.element(el).controller('ttEventDetail');
   if(!c||String(c.event?.Id)!==id)return undefined;
   const own=c.getCurrentUserTimeSlot?.();
   const rules=c.event.RegistrationRules;
   return {id,attending:c.event.IsAttending===true,on_waitlist:rules?.IsOnWaitlist===true,
    slot_id:own?.Id===undefined?null:String(own.Id),selected_slot:slot||null,
    can_register:rules?.CanRegister===true,can_waitlist:rules?.CanRegisterForWaitlist===true,
    can_cancel:rules?.CanCancelRegistration===true,reason:rules?.CannotRegisterReason||null,
    registration_begin:c.event.RegistrationBeginDate,registration_end:c.event.RegistrationEndDate};
  },{id:change.target_id,slot:change.slot_id});
 }
 private async open(change:Change):Promise<OpenForm> {
  this.validate(change);
  const readArea:Area=change.area==="outcomes"?"profile":change.area==="applications"?"jobs":change.area;
  const before=await this.reads.read({area:readArea,id:change.target_id,limit:100,view:change.fields._target_type===undefined?undefined:String(change.fields._target_type)});
  const page=await this.browser.page();
  let scope=await formScope(page);let final=/^(Save|Save Changes|Submit)$/i;let favorite:Locator|undefined;let deleteControl:Locator|undefined;
  const operation=change.operation;
  const registration=await this.registrationState(page,change);
  if(operation==="favorite_set"){
   const choices=scope.getByRole("checkbox",{name:/^(un)?favorited$/i});
   if(await choices.count()!==1)throw new CmsError("action_unavailable","This exact record does not expose a favorite control.");
   favorite=choices;
  } else if(deletion.test(operation)){
   const record=change.target_id?await this.recordScope(page,change.target_id,change.area):scope;
   const pattern=operation==="application_withdraw"?/^Withdraw( Application)?$/i:operation==="resume_book_withdraw"?/^(Withdraw|Remove Resume)$/i:operation.endsWith("_cancel")?/^(Cancel (Registration|Appointment|Interview)|Unregister)$/i:/^(Delete|Remove)( Task| Document| Contact| Experience| Education| Status| Target)?$/i;
   // Opening a menu is read-only; clicking its destructive item is deferred until commit.
   try{deleteControl=await this.control(record,pattern);}catch{
    await this.openButton(record,/^(Options|Actions|More)$/i);
    deleteControl=await this.control(page.locator("body"),pattern);
   }
   final=pattern;
  } else switch(operation){
   case "application_submit":{
    const apply=scope.locator('a[href*="/application"]');
    if(await apply.count()!==1){
     const links=await scope.locator("a[href]").evaluateAll(es=>es.filter(e=>/apply/i.test(e.textContent||"")).map(e=>(e as HTMLAnchorElement).href));
     throw new CmsError("external_application","CMS does not expose a native application form for this posting.",{links});
    }
    const href=await apply.getAttribute("href");const url=new URL(href!,CMS_ORIGIN);
    if(url.origin!==CMS_ORIGIN)throw new CmsError("external_application","Complete this application at the employer's site.",{url:url.href});
    await page.goto(url.href,{waitUntil:"domcontentloaded"});await page.getByRole("button",{name:"Apply",exact:true}).waitFor();scope=await formScope(page);final=/^Apply$/i;break;
   }
   case "document_upload":{
    const category=String(change.fields._document_type||"Resumes");
    const icon=page.locator('i[aria-label='+JSON.stringify("'Add New "+category+"'")+']');
    if(await icon.count()!==1)throw new CmsError("action_unavailable","This document category is not available.");
    await icon.locator("..").evaluate(e=>(e as HTMLElement).click());scope=await this.waitForm(page);break;
   }
   case "resume_book_submit":
    await this.openButton(scope,/^Upload$/i);scope=await this.waitForm(page);break;
   case "task_create":
    await this.openButton(scope,/^Add Task$/i);scope=await this.waitForm(page);final=/^Save Changes$/i;break;
   case "profile_image_update":
    await this.openButton(scope,/^(Change Image|Change Profile Image)$/i);scope=await this.waitForm(page);break;
   case "profile_update":{
    const section=String(change.fields._section||"General");
    if(section==="Summary"){
     await this.openButton(scope,/^(Add Summary|Edit Summary)$/i);
    }else{
     await this.reads.navigate("profile",undefined,"profile");
     const headings=page.getByRole("heading",{name:section,exact:true});
     if(await headings.count()!==1)throw new CmsError("action_unavailable","CMS did not expose the selected profile section.");
     await this.openButton(headings.locator(".."),/^Edit$/i);
    }
    scope=await this.waitForm(page);break;
   }
   case "outcome_create":
   case "experience_create":{
    await this.reads.navigate("dashboard");scope=await formScope(page);
    await this.openButton(scope,/^Report Status$/i);
    const kind=String(change.fields._outcome||"");
    if(!outcomes.includes(kind))throw new CmsError("required_field","Choose _outcome from the supported CMS status choices.",{choices:outcomes});
    await this.openButton(scope,exact(kind));
    await page.waitForFunction(()=>/JobInputForm|JobStatus|EmploymentStatus/i.test(location.href)||!!document.querySelector(".modal.in"),null,{timeout:10000});
    scope=await formScope(page);final=/^(Submit|Save)$/i;break;
   }
   case "education_create":
    await this.openButton(scope,/^Add Education Experience$/i);scope=await this.waitForm(page);break;
   case "contact_create":
    await this.openButton(scope,/^(Add|New|Create)( Personal)? Contact$/i);scope=await this.waitForm(page);break;
   case "activity_create":
    await this.openButton(scope,/^(Add|New|Create) Activity$/i);scope=await this.waitForm(page);break;
   case "target_add":
    final=/^\+?\s*Add To Target (Employers|Contacts)$/i;break;
   case "event_register":{
    if(!registration||(!registration.can_register&&!registration.can_waitlist))
     throw new CmsError("action_unavailable","CMS does not permit registration for this exact event.",registration);
    if(change.slot_id){
     const chosen=before.records.find(r=>r.id===change.slot_id);
     if(!chosen||chosen.canRegisterForTimeslot!==true)throw new CmsError("action_unavailable","The exact event slot is unavailable.");
    }
    const href=CMS_ORIGIN+"/events#/events/"+encodeURIComponent(change.target_id!)+"/registration"+(change.slot_id?"?timeSlotId="+encodeURIComponent(change.slot_id):"");
    await page.goto(href,{waitUntil:"domcontentloaded"});
    await page.locator("tt-edit-registration").waitFor();
    scope=await formScope(page);
    final=/^(Register|Submit|Confirm Registration)$/i;
    await this.control(scope,final);
    break;
   }
   case "appointment_book":
   case "interview_book":{
    // Read-only detail adapters bind exact schedule identities before this point.
    if(change.slot_id){
     scope=await this.recordScope(page,change.slot_id,change.area);
    }
    final=/^(Book Appointment|Book|Reserve|Register|Schedule|Sign Up)$/i;
    const node=await this.control(scope,final);
    const handler=await node.getAttribute("ng-click")||await node.getAttribute("tt-click")||"";
    // Only known form-opening handlers are allowed during preview. A register/book handler
    // can submit immediately and is therefore left entirely for the confirmed commit.
    if(/\.(show\w*(Modal|Form)|open\w*Form)\(/.test(handler)){
     await node.evaluate(e=>(e as HTMLElement).click());scope=await this.waitForm(page);
     final=/^(Submit|Book|Register|Confirm|Save)$/i;
    }
    break;
   }
   case "saved_search_create":{
    const save=await this.control(scope,/^(Save this search|Turn on e-mail alerts for this search|Turn on email alerts for this search)$/i);
    const handler=await save.getAttribute("ng-click")||await save.getAttribute("tt-click")||"";
    if(!/\.(showSaveSearchModal|showSaveSearchForm|openSaveSearchForm)\(/.test(handler))
     throw new CmsError("action_unavailable","This saved-search control has no reviewed read-only form opener. Use CMS interactively.");
    await save.evaluate(e=>(e as HTMLElement).click());scope=await this.waitForm(page);break;
   }
   case "settings_update":
    await this.openButton(scope,/^Edit$/i);scope=await this.waitForm(page);break;
   default:{
    const record=change.target_id?await this.recordScope(page,change.target_id,change.area):scope;
    try{await this.openButton(record,/^Edit( Task| Document| Contact| Experience| Education| Status| Search)?$/i);}catch{
     await this.openButton(record,/^(Options|Actions|More)$/i);
     await this.openButton(page.locator("body"),/^Edit( Task| Document| Contact| Experience| Education| Status| Search)?$/i);
    }
    scope=await this.waitForm(page);
   }
  }
  if(new URL(page.url()).origin!==CMS_ORIGIN)throw new CmsError("external_workflow","This workflow requires an external site.",{url:page.url()});
  const fields=favorite?[{id:"_favorite",label:"Favorite",type:"checkbox",required:false,value:await favorite.isChecked()}]:deleteControl?[]:await inspectFields(scope);
  if(!favorite&&!deleteControl)await this.control(scope,final);
  const context={
   registration,
   title:before.title,target_id:change.target_id,slot_id:change.slot_id,timezone:TIMEZONE,
   record:change.target_id?before.records.find(r=>r.id===change.target_id):undefined,
   // Eligibility and descriptions on individual scheduling/application pages are part of approval.
   ...( ["jobs","applications","events","appointments","interviews","resume_books"].includes(change.area)?{details:before.text}:{}),
   section:change.fields._section,outcome:change.fields._outcome,document_type:change.fields._document_type,
   effects:operation==="application_submit"?["Upload selected documents","Optional save to application materials as displayed","Submit application"]:operation==="resume_book_submit"?["Upload selected resume","Publish resume-book participation with the displayed visibility choice"]:[operation]
  };
  const form:FormResult={operation,area:change.area,target_id:change.target_id,supported:true,url:page.url(),fields,actions:[operation],context};
  return {page,scope,form,final,before,favorite,deleteControl};
 }
 async form(change:Change):Promise<FormResult>{
  try{return (await this.open(change)).form;}
  catch(error){
   if(error instanceof CmsError&&["action_unavailable","record_unavailable","external_application","external_workflow"].includes(error.code)){
    return {operation:change.operation,area:change.area,target_id:change.target_id,supported:false,reason:error.message,url:(await this.browser.page()).url(),fields:[],actions:[],context:{code:error.code,details:error.details}};
   }
   throw error;
  }
 }
 private validateIntent(change:Change,form:FormResult) {
  if(change.operation==="favorite_set"&&typeof change.fields._favorite!=="boolean")
   throw new CmsError("invalid_field","Set _favorite to true or false.");
  if(change.operation==="task_complete"){
   const status=form.fields.find(f=>f.id==="statusId");
   const complete=status?.options?.find(o=>/^Complete$/i.test(o.label));
   if(!complete||![complete.value,complete.label].includes(String(change.fields.statusId)))
    throw new CmsError("required_field","For task_complete, explicitly set statusId to the Complete choice in the preview.");
  }
 }
 async prepare(change:Change):Promise<Prepared>{
  const identity=await this.browser.identity();
  const opened=await this.open(change);
  this.validateIntent(change,opened.form);
  validateFields(opened.form.fields,change.fields,change.files.map(f=>f.field),reserved);
  if(["document_upload","resume_book_submit","profile_image_update"].includes(change.operation)&&opened.form.fields.some(f=>f.type==="file")&&!change.files.length)
   throw new CmsError("required_file","Choose the document returned by cms_get_form before preparing the upload.");
  return {identity:identity.key,preview:{operation:change.operation,account:identity.name,account_id:identity.account_id,area:change.area,target_id:change.target_id,slot_id:change.slot_id,form:opened.form,changes:change.fields,files:change.files.map(f=>({field:f.field,path:f.path}))}};
 }
 async submit(change:Change,recordEffect:RecordEffect):Promise<MutationResult>{
  const opened=await this.open(change);const effects:Effect[]=[];
  const intend=async(name:string)=>{const e:Effect={name,status:"intended",target:change.target_id};effects.push(e);await recordEffect(e);};
  const verifyEffects=async()=>{for(const e of effects){e.status="verified";await recordEffect(e);}};
  if(opened.favorite){
   const wanted=change.fields._favorite as boolean;
   if(await opened.favorite.isChecked()!==wanted){
    await intend("set_favorite");
    await opened.favorite.evaluate(e=>(e as HTMLElement).click());
   }else{await intend("favorite_already_matches");}
   await this.reads.navigate(change.area,change.target_id);
   const state=(await formScope(opened.page)).getByRole("checkbox",{name:/^(un)?favorited$/i});
   if(await state.count()===1&&await state.isChecked()===wanted){
    await verifyEffects();return {status:"verified",url:opened.page.url(),effects,result:{favorite:wanted,target_id:change.target_id}};
   }
   return {status:"uncertain",url:opened.page.url(),effects};
  }
  this.validateIntent(change,opened.form);
  validateFields(opened.form.fields,change.fields,change.files.map(f=>f.field),reserved);
  if(opened.deleteControl){
   await intend(change.operation);await opened.deleteControl.evaluate(e=>(e as HTMLElement).click());
   // Some CMS delete actions open a confirmation modal. This is the only accepted second stage.
   const dialog=opened.page.locator(".modal:visible,[role=dialog]:visible");
   if(await dialog.count()){
    const text=await dialog.last().innerText();
    if(/are you sure|permanently|confirm|cancel.*registration|withdraw/i.test(text)){
     await intend("confirm_"+change.operation);await clickNamed(dialog.last(),/^(Delete|Remove|Withdraw|Confirm|Yes|Cancel Registration|Cancel Appointment)$/i);
    }
   }
  }else{
   if(Object.keys(change.fields).some(k=>!reserved.includes(k))){
    await intend("update_approved_fields");
    await fillFields(opened.scope,opened.form.fields,change.fields,reserved);
   }
   for(const file of change.files){
    const field=opened.form.fields.find(f=>f.id===file.field&&f.type==="file")!;
    await intend("upload_"+file.field);
    await (await fieldLocator(opened.scope,field)).setInputFiles(file.path);
    // Wait for the existing uploader to finish; never click final submit while uploading.
    await opened.page.waitForFunction(()=>![...document.querySelectorAll(".progress-bar,.upload-progress")].some(e=>e.getClientRects().length&&!/100/.test(e.getAttribute("aria-valuenow")||e.textContent||"")),null,{timeout:60000}).catch(()=>{throw new CmsError("upload_uncertain","The upload did not reach a verified ready state.");});
   }
   await intend(change.operation);
   await clickNamed(opened.scope,opened.final);
  }
  // Observe completion, never replay the final control. Validation errors can leave a partial upload.
  await opened.page.waitForFunction(()=>![...document.querySelectorAll(".modal.in,.modal.show")].some(e=>e.getClientRects().length)||!!document.querySelector(".validation-summary-errors,.field-validation-error,.alert-danger"),null,{timeout:15000}).catch(()=>{});
  const errors=await opened.page.locator(".validation-summary-errors:visible,.field-validation-error:visible,.alert-danger:visible").allTextContents();
  if(errors.some(t=>t.trim()))return {status:"partial",url:opened.page.url(),effects,result:{validation_errors:errors}};
  let after:ReadResult;
  try{after=await this.reads.read({area:change.area==="applications"?"jobs":change.area==="outcomes"?"profile":change.area,id:change.target_id,limit:100});}
  catch(error){
   if(opened.deleteControl&&error instanceof CmsError&&["not_found","record_not_found"].includes(error.code)){
    await verifyEffects();return {status:"verified",url:opened.before.url,effects,result:{deleted:change.target_id}};
   }
   return {status:"uncertain",url:opened.page.url(),effects};
  }
  let verified=false;let pending=false;
  if(["event_register","appointment_book","interview_book","application_submit","resume_book_submit"].includes(change.operation)){
   // Completion messages are not proof: they may be static text or refer to
   // another record. Only a current-account state bound to this target qualifies.
   if(change.operation==="event_register"){
    const state=await this.registrationState(opened.page,change);
    pending=state?.on_waitlist===true;
    verified=!!state&&(state.attending||pending)&&(!change.slot_id||state.slot_id===change.slot_id);
   }
  }else if(opened.deleteControl){
   verified=opened.before.records.some(r=>r.id===change.target_id)&&!after.records.some(r=>r.id===change.target_id)&&!after.truncated&&!after.next_cursor;
   if(change.operation==="event_cancel"){
    const state=await this.registrationState(opened.page,change);
    const prior=opened.form.context.registration as {attending?:boolean;on_waitlist?:boolean}|undefined;
    verified=!!state&&(prior?.attending===true||prior?.on_waitlist===true)&&!state.attending&&!state.on_waitlist;
   }
  }else{
   const candidates=after.records.filter(r=>!opened.before.records.some(b=>b.id===r.id));
   let check=change;
   if(change.operation.endsWith("_create")){
    if(candidates.length===1)check={...change,target_id:candidates[0].id,operation:change.operation.replace(/_create$/,"_update") as Operation};
   }else if(change.operation==="document_upload"){
    // A new list row alone cannot prove that the approved file bytes were saved.
    verified=false;
   }
   if(!verified&&(!change.operation.endsWith("_create")||check.target_id)){
    try{
     const persisted=await this.open(check);
     const requested=Object.entries(change.fields).filter(([k])=>!reserved.includes(k));
     verified=requested.length>0&&requested.every(([key,value])=>{
      const field=persisted.form.fields.find(f=>f.id===key);
      const desired=field?.options?(Array.isArray(value)?value:[String(value)]).map(v=>field.options!.find(o=>o.value===v||o.label===v)?.value):value;
      const normalized=field?.type==="multiselect"?[...(field.value as string[]||[])].sort():String(field?.value??"");
      const expect=Array.isArray(desired)?(field?.type==="multiselect"?[...desired].sort():String(desired[0])):String(desired??"");
      return JSON.stringify(normalized)===JSON.stringify(expect);
     });
    }catch{}
   }
  }
  if(verified&&change.files.length){
   const finalEffect=effects.find(e=>e.name===change.operation);
   if(finalEffect){finalEffect.status="verified";await recordEffect(finalEffect);}
   return {status:"partial",url:after.url,effects,result:{target_id:change.target_id,message:"The final record changed, but CMS did not expose an authoritative file hash for every upload. Reconcile the uploaded documents before another change."}};
  }
  if(verified){await verifyEffects();return {status:pending?"pending":"verified",url:after.url,effects,result:{target_id:change.target_id,records:after.records,text:after.text}};}
  return {status:effects.length>1?"partial":"uncertain",url:after.url,effects,result:{message:"CMS did not expose enough authoritative state to verify every approved effect. Inspect the linked record before reconciling.",records:after.records}};
 }
}
