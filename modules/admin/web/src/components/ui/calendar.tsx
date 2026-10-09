import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker, type DayPickerProps } from "react-day-picker"
import { ru } from "react-day-picker/locale"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** A month grid in the admin's own tokens: react-day-picker's structure, shadcn's classes, Russian labels. */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: DayPickerProps) {
  return (
    <DayPicker
      locale={ru}
      weekStartsOn={1}
      showOutsideDays={showOutsideDays}
      className={cn("relative p-3", className)}
      classNames={{
        months: "flex flex-col gap-4",
        month: "flex flex-col gap-4",
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium capitalize",
        nav: "absolute inset-x-3 top-3 flex h-7 items-center justify-between",
        button_previous: cn(buttonVariants({ variant: "outline" }), "size-7 p-0 opacity-60 hover:opacity-100"),
        button_next: cn(buttonVariants({ variant: "outline" }), "size-7 p-0 opacity-60 hover:opacity-100"),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-[0.8rem] font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "relative size-8 p-0 text-center text-sm",
        day_button: cn(buttonVariants({ variant: "ghost" }), "size-8 p-0 font-normal"),
        selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
        today: "[&>button]:font-semibold [&>button]:underline",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeftIcon className="size-4" /> : <ChevronRightIcon className="size-4" />,
      }}
      {...props}
    />
  )
}

export { Calendar }
