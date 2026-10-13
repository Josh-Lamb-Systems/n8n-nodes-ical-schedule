<?php
// php harness_multi.php <file.ics> <tz> <days> <date1,date2,...>  -> {date: schedule}
include(__DIR__ . "/ical.php");
[$_, $file, $tz, $days, $dateList] = $argv;
date_default_timezone_set($tz);
function daysBetween($dt1, $dt2) { return date_diff(date_create($dt2), date_create($dt1))->format('%a'); }
function formatEvent($event, $fullday = false) {
  $t = ["title" => $event->summary];
  if ($fullday) { $t["fullday"] = true;
    $t["start"] = date_format(date_create($event->dateStart), "Y-m-d");
    $t["end"] = date_format(date_create($event->dateEnd), "Y-m-d");
  } else { $t["fullday"] = false;
    $t["start"] = date_format(date_create($event->dateStart), "H:i");
    $t["end"] = date_format(date_create($event->dateEnd), "H:i");
  }
  if (isset($event->location)) $t["location"] = $event->location;
  return $t;
}
$iCal = new iCal(file_get_contents($file));
$all = [];
foreach (explode(',', $dateList) as $todayStr) {
  $todayTs = strtotime($todayStr . " 12:00:00");
  $schedule = $iCal->eventsByDateUntil(strtotime('+' . ($days - 1) . ' days', $todayTs));
  $temp = [];
  for ($i = 0; $i < $days; $i++) $temp[date("Y-m-d", strtotime("+$i day", $todayTs))] = [];
  foreach ($schedule as $day) {
    if (!is_array($day)) continue;
    foreach ($day as $event) {
      $dateDiff = daysBetween($event->dateStart, $event->dateEnd);
      if ($dateDiff == 0) {
        $start = date_format(date_create($event->dateStart), "Y-m-d");
        if (array_key_exists($start, $temp)) $temp[$start][] = formatEvent($event);
      } else {
        for ($i = 0; $i < $dateDiff; $i++) {
          $d = date("Y-m-d", strtotime($event->dateStart . " +$i day"));
          if (array_key_exists($d, $temp)) $temp[$d][] = formatEvent($event, true);
        }
      }
    }
  }
  $all[$todayStr] = $temp;
}
echo json_encode($all, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
