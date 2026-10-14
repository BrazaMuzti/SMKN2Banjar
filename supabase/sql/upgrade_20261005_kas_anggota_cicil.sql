-- ============================================================
-- UPGRADE 2026-10-05: KAS ANGGOTA - STATUS "CICIL" + TANGGAL AKHIR BAYAR
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Tab "Kas Anggota" (Menu Ekstrakurikuler) hanya mengenal status
--   'lunas'/'menunggak'. Perlu status 'cicil' agar anggota bisa membayar
--   sebagian, dengan pencatatan akumulasi nominal yang sudah dibayar dan
--   sisa tagihan. Baris berstatus 'menunggak' juga perlu tenggat waktu
--   pembayaran (tanggal_akhir_bayar) yang ditentukan saat pencatatan iuran.
--
-- Isi file ini:
--   1) iuran_anggota.status: tambah nilai 'cicil' pada check constraint.
--   2) iuran_anggota.nominal_dibayar: akumulasi nominal yang sudah dibayar
--      (dipakai saat status 'cicil'; 0 bila 'menunggak', = nominal bila 'lunas').
--   3) iuran_anggota.tanggal_akhir_bayar: tenggat pembayaran, diisi saat
--      status 'menunggak' atau 'cicil'.
--   4) RPC iuran_anggota_rentang: sertakan kolom baru di hasil.
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. KOLOM BARU ==========
alter table iuran_anggota add column if not exists nominal_dibayar numeric(14, 2) not null default 0;
alter table iuran_anggota add column if not exists tanggal_akhir_bayar date;

-- Data lama: baris 'lunas' dianggap sudah dibayar penuh.
update iuran_anggota set nominal_dibayar = nominal where status = 'lunas' and nominal_dibayar = 0;

-- ========== 2. STATUS 'cicil' PADA CHECK CONSTRAINT ==========
alter table iuran_anggota drop constraint if exists iuran_anggota_status_check;
alter table iuran_anggota add constraint iuran_anggota_status_check
  check (status in ('lunas', 'menunggak', 'cicil'));

-- ========== 3. RPC iuran_anggota_rentang: SERTAKAN KOLOM BARU ==========
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
      i.nominal_dibayar,
      i.tanggal_akhir_bayar,
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
