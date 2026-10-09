import { z } from 'zod';
import type { PersonnelData, WorkSchedule } from './types';
import type { TransportData, TransportPlan } from '../transport/types';

const id = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().max(500);
const required = text.min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value, 'Ange ett giltigt datum.');
const minute = z.number().int().min(0).max(1440);
const revision = z.number().int().nonnegative().default(0);
export const personSchema = z.object({id, name:required, kind:z.enum(['employee','external']), active:z.boolean(), role:text, team:text, siteIds:z.array(id).min(1).max(50), managerId:id.optional(), companyId:id.optional(), employeeNumber:text.optional(), phone:text, email:text, address:text, userId:id.optional(), driverId:id.optional(), vehicleId:id.optional(), canDrive:z.boolean(), revision});
export const companySchema = z.object({id, name:required, number:text, contact:text, phone:text, email:text});
export const employmentSchema = z.object({personId:id, form:z.enum(['permanent','temporary','probation','hourly']), startDate:date, endDate:date.optional(), percentage:z.number().min(0).max(100), hoursPerWeek:z.number().min(0).max(168), revision}).refine(value=>!value.endDate || value.endDate>=value.startDate,'Slutdatum får inte ligga före startdatum.');
export const salarySchema = z.object({personId:id, kind:z.enum(['monthly','hourly']), amount:z.number().finite().min(0).max(1e8), effectiveFrom:date, nextReview:date.optional(), note:text, revision});
export const scheduleSchema = z.object({id,personId:id,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),startMinute:minute,endMinute:minute,lunchStart:minute.optional(),lunchEnd:minute.optional(),effectiveFrom:date,effectiveTo:date.optional(),revision}).superRefine((value,ctx)=>{
  if(value.endMinute<=value.startMinute)ctx.addIssue({code:'custom',message:'Arbetspasset måste sluta efter start.',path:['endMinute']});
  if((value.lunchStart===undefined)!==(value.lunchEnd===undefined) || value.lunchStart!==undefined && (value.lunchStart<value.startMinute || value.lunchEnd!>value.endMinute || value.lunchStart>=value.lunchEnd!))ctx.addIssue({code:'custom',message:'Lunchen måste rymmas inom arbetspasset.',path:['lunchStart']});
  if(value.effectiveTo && value.effectiveTo<value.effectiveFrom)ctx.addIssue({code:'custom',message:'Slutdatum ligger före startdatum.',path:['effectiveTo']});
});
export const absenceSchema = z.object({id,personId:id,kind:z.enum(['sick','holiday','vab','leave','training']),fromDate:date,toDate:date,allDay:z.boolean(),startMinute:minute.optional(),endMinute:minute.optional(),managerId:id.optional(),status:z.enum(['registered','cancelled']),createdAt:z.string().datetime(),createdBy:id,revision}).superRefine((value,ctx)=>{
  if(value.toDate<value.fromDate)ctx.addIssue({code:'custom',message:'Slutdatum ligger före startdatum.',path:['toDate']});
  if(!value.allDay && (value.startMinute===undefined || value.endMinute===undefined || value.startMinute>=value.endMinute))ctx.addIssue({code:'custom',message:'Ange tider för del av dag.',path:['startMinute']});
});
export const competencySchema = z.object({id,personId:id,type:z.enum(['license','ykb','adr','employer','other']),name:required,codes:z.array(required).min(1).max(30),scope:text,validFrom:date,validTo:date.optional(),verified:z.boolean(),verifiedBy:id.optional(),verifiedAt:z.string().datetime().optional(),revision}).refine(value=>!value.validTo || value.validTo>=value.validFrom,'Giltighetsperioden är felaktig.');
export function personnelSchedules(data:PersonnelData,personId:string,day:string):WorkSchedule[] {
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
  return data.schedules.filter(s=>s.personId===personId && s.weekdays.includes(weekday) && s.effectiveFrom<=day && (!s.effectiveTo || s.effectiveTo>=day));
}
export function personnelDriverAvailability(data:PersonnelData,driverId:string,day:string): {fromMinute:number;toMinute:number;kind:'shift'|'lunch'|'absence';label:string}[] {
  const person=data.people.find(p=>p.driverId===driverId);
  if(!person)return [];
  const result:{fromMinute:number;toMinute:number;kind:'shift'|'lunch'|'absence';label:string}[]=personnelSchedules(data,person.id,day).flatMap(s=>[{fromMinute:s.startMinute,toMinute:s.endMinute,kind:'shift' as const,label:'Arbetspass'},...(s.lunchStart!==undefined ? [{fromMinute:s.lunchStart,toMinute:s.lunchEnd!,kind:'lunch' as const,label:'Lunch'}] : [])]);
  for(const a of data.absences.filter(a=>a.personId===person.id && a.status==='registered' && a.fromDate<=day && a.toDate>=day))result.push({fromMinute:a.allDay?0:a.startMinute!,toMinute:a.allDay?1440:a.endMinute!,kind:'absence',label:'Ej tillgänglig'});
  return result;
}
/** Exact job date checks, shared by transport preview and authoritative transaction.
 * Existing conflicting bookings are preserved; callers validate only changed plans. */
export function personnelPlanIssues(data:PersonnelData,transport:TransportData,orderId:string,plan:TransportPlan):string[] {
  const person=data.people.find(p=>p.driverId===plan.driverId), order=transport.orders.find(o=>o.id===orderId), vehicle=transport.vehicles.find(v=>v.id===plan.vehicleId);
  if(!person)return ['Föraren saknar personalkoppling.'];
  const issues:string[]=[];
  if(!person.active || !person.canDrive)issues.push('Föraren är inte aktiv och bokningsbar.');
  const end=plan.startMinute+plan.durationMinutes;
  const shifts=personnelSchedules(data,person.id,plan.date);
  if(!shifts.some(s=>s.startMinute<=plan.startMinute && s.endMinute>=end && !(s.lunchStart!==undefined && s.lunchStart<end && s.lunchEnd!>plan.startMinute)))issues.push(shifts.some(s=>s.lunchStart!==undefined && s.lunchStart<end && s.lunchEnd!>plan.startMinute) ? 'Uppdraget överlappar förarens lunch.' : 'Uppdraget ligger utanför registrerat arbetspass.');
  if(data.absences.some(a=>a.personId===person.id && a.status==='registered' && a.fromDate<=plan.date && a.toDate>=plan.date && (a.allDay || a.startMinute!<end && a.endMinute!>plan.startMinute)))issues.push('Föraren är frånvarande under uppdraget.');
  if(!vehicle || !order || !vehicle.types.includes(order.vesselType))issues.push('Fordonet kan inte hantera uppdragets kärltyp.');
  const requirements=[...(order?.requiredCompetencies??[]),...(vehicle?.requiredCompetencies??[])];
  for(const code of new Set(requirements)) {
    const match=data.competencies.some(c=>c.personId===person.id && c.verified && c.validFrom<=plan.date && (!c.validTo || c.validTo>=plan.date) && c.codes.some(value=>`${c.type}:${value}`.toLowerCase()===code.toLowerCase() || value.toLowerCase()===code.toLowerCase()));
    if(!match)issues.push(`Obligatorisk kompetens saknas eller är utgången: ${code}.`);
  }
  const effective=transport.orders.map(o=>transport.preliminary[o.id]?{...o,...transport.preliminary[o.id],status:'booked'}:o);
  const clash=effective.find(o=>o.id!==orderId && !['unbooked','cancelled','done'].includes(o.status) && o.date===plan.date && o.startMinute!==undefined && (o.driverId===plan.driverId || o.vehicleId===plan.vehicleId) && o.startMinute<end && o.startMinute+o.durationMinutes>plan.startMinute);
  if(clash)issues.push(`Föraren eller fordonet är redan bokat (${clash.id}).`);
  return issues;
}
