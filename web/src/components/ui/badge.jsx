import { cn } from '../../lib/utils';

const variants = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  brand: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  // 推理强度专用：默认/低/中/高/极高/最大
  plain: 'bg-zinc-50 text-zinc-900 ring-zinc-300',
  gray: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  purple: 'bg-violet-50 text-violet-700 ring-violet-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
};

export function Badge({ className, variant = 'neutral', ...props }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', variants[variant], className)}
      {...props}
    />
  );
}
