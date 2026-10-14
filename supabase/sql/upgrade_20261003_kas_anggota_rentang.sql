-- ============================================================
-- UPGRADE 2026-10-03: KAS ANGGOTA - FILTER RENTANG TANGGAL
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Tab "Kas Anggota" (Menu Ekstrakurikuler) semula hanya bisa difilter per
--   Tahun + Bulan (RPC matriks_iuran_anggota). Diganti menjadi filter rentang
--   "Dari tanggal" s.d. "Sampai tanggal" agar konsisten dengan Kas Umum.
--
-- Isi file ini:
--   1) RPC iuran_anggota_rentang(p_ekskul, p_dari, p_sampai) -- data iuran per
--      rentang tanggal efektif (tanggal_bayar bila ada, atau tanggal turunan
--      dari tahun/bulan/periode_label untuk baris yang masih menunggak).
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

create or replace function iuran_anggota_rentang(p_ekskul text, p_dari date default null, p_sampai date default null)
returns json as $$
declare
  v_result json;
begin
  select coalesce(json_agg(row_to_json(t) order by t.tgl_efektif), '[]'::json) into v_result
  from (
    select
      i.id,
      i.nis_nip,
      i.periode_tipe,
      i.periode_label,
      i.tahun,
      i.bulan,
      i.deskripsi_pembayaran,
      i.nominal,
      i.status,
      i.tanggal_bayar,
      coalesce(
        i.tanggal_bayar,
        case
          when i.periode_tipe = 'harian' and i.periode_label ~ '^\d{4}-\d{2}-\d{2}$'
            then i.periode_label::date
          when i.periode_tipe = 'mingguan'
            then make_date(i.tahun, coalesce(i.bulan, 1), 1)
          else make_date(i.tahun, coalesce(i.bulan, 1), 1)
        end
      ) as tgl_efektif
    from iuran_anggota i
    where i.ekskul = p_ekskul
  ) t
  where (p_dari is null or t.tgl_efektif >= p_dari)
    and (p_sampai is null or t.tgl_efektif <= p_sampai);
  return v_result;
end;
$$ language plpgsql stable security definer;

grant execute on function iuran_anggota_rentang(text, date, date) to anon, authenticated;

-- Reload cache skema PostgREST
notify pgrst, 'reload schema';
